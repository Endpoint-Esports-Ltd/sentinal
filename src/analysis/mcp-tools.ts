/**
 * Analysis MCP Tools
 *
 * Registers spec-aware analysis tools on an MCP server.
 * Provides:
 *   - check_diagnostics: tsc with delta tracking and spec-file filtering
 *   - impact_analysis: change impact with plan-context cross-referencing and risk scoring
 *   - quality_report: tsc/eslint/prettier — project-wide is report-only; only
 *     an explicit `file` inside the project is auto-fixed (D1)
 *
 * Unlike raw bash commands, these tools leverage Sentinal's persistent state:
 *   - check_diagnostics caches tsc baselines in SQLite for delta tracking
 *   - impact_analysis cross-references git diff against the active spec's task files
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import {
  withAbort,
  emitProgress,
  type ProgressExtra,
} from "../mcp/tool-runtime.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import type { SidecarClient } from "../sidecar/client.js";
import {
  runQualityChecks,
  resolveQualityTarget,
  type QualityCheckRequest,
  type QualityCheckResult,
  type CheckName,
} from "../sidecar/quality-routes.js";
import { formatQualityReport } from "./quality-format.js";
import {
  projectHash,
  parseTscOutput,
  extractSpecFiles,
  countUniqueFiles,
  type DiagnosticsBaseline,
} from "./helpers.js";
import { registerImpactAnalysisTool } from "./impact.js";
import { registerPlanImpactTool } from "./plan-impact.js";

// --- Public API ---

export interface AnalysisToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}

export function registerAnalysisTools(
  server: McpServer,
  deps: AnalysisToolsDeps,
): void {
  const { client = null, store = null } = deps;
  const effectiveStore = store ?? (client ? null : new MemoryStore());
  const specStore = effectiveStore ? new SpecStore(effectiveStore) : null;

  registerCheckDiagnosticsTool(server, client, effectiveStore, specStore);
  // `client` is required, not decorative: with a sidecar `store` is null, so
  // `specStore` is null and impact_analysis has no other way to see the spec.
  registerImpactAnalysisTool(server, specStore, null, client);
  registerPlanImpactTool(server, specStore, client);
  registerQualityReportTool(server, client);
}

// --- check_diagnostics ---

function registerCheckDiagnosticsTool(
  server: McpServer,
  client: SidecarClient | null,
  store: MemoryStore | null,
  specStore: SpecStore | null,
): void {
  server.tool(
    "check_diagnostics",
    "Run TypeScript diagnostics filtered to spec-relevant files with delta tracking from the previous run. More useful than npx tsc --noEmit directly: shows only plan-relevant errors in detail, summarizes unrelated errors, and reports 'N NEW / N FIXED' delta from last check.",
    {
      project: z
        .string()
        .describe(
          "Absolute path to the project root (where tsconfig.json lives)",
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 30000)"),
    },
    async ({ project, timeout_ms }) => {
      const timeoutMs = timeout_ms ?? 30000;

      try {
        // Try LSP-based diagnostics via sidecar first
        let currentErrors: ReturnType<typeof parseTscOutput> = [];
        let usedLsp = false;

        if (client) {
          try {
            const qr = await client.qualityCheck({
              projectPath: project,
              checks: ["tsc"],
            });
            if (qr.tsc && !qr.tsc.timedOut) {
              currentErrors = qr.tsc.errors.map((e) => {
                const m = e.match(/^(.+?)\((\d+),(\d+)\): (.+)$/);
                return m
                  ? {
                      file: m[1],
                      line: parseInt(m[2]),
                      column: parseInt(m[3]),
                      message: m[4],
                    }
                  : { file: "unknown", line: 0, column: 0, message: e };
              });
              usedLsp = true;
            }
          } catch {
            /* sidecar unavailable, fall through to direct tsc */
          }
        }

        if (!usedLsp) {
          const proc = Bun.spawn(
            ["npx", "tsc", "--noEmit", "--pretty", "false"],
            { cwd: project, stdout: "pipe", stderr: "pipe" },
          );
          const timeoutPromise = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
          );
          const result = await Promise.race([proc.exited, timeoutPromise]);
          if (result === "timeout") {
            proc.kill();
            return mcpText(
              `TIMEOUT: tsc did not complete within ${timeoutMs}ms.`,
            );
          }
          currentErrors = parseTscOutput(await proc.stdout.text());
        }
        const errorCount = currentErrors.length;

        // Load baseline from cache
        const cacheKey = `diagnostics:${projectHash(project)}`;
        const cachedRaw = store?.getSetting(cacheKey) ?? null;
        let baseline: DiagnosticsBaseline | null = null;
        if (cachedRaw) {
          try {
            baseline = JSON.parse(cachedRaw) as DiagnosticsBaseline;
          } catch {
            baseline = null;
          }
        }

        // Compute delta
        let deltaText = "";
        if (baseline !== null) {
          const prevKeys = new Set(
            baseline.errors.map((e) => `${e.file}:${e.line}:${e.message}`),
          );
          const currKeys = new Set(
            currentErrors.map((e) => `${e.file}:${e.line}:${e.message}`),
          );
          const newErrors = currentErrors.filter(
            (e) => !prevKeys.has(`${e.file}:${e.line}:${e.message}`),
          );
          const fixedCount = baseline.errors.filter(
            (e) => !currKeys.has(`${e.file}:${e.line}:${e.message}`),
          ).length;
          if (newErrors.length > 0 || fixedCount > 0) {
            const parts: string[] = [];
            if (newErrors.length > 0) parts.push(`**${newErrors.length} NEW**`);
            if (fixedCount > 0) parts.push(`**${fixedCount} FIXED**`);
            deltaText = `\n**Delta:** ${parts.join(", ")} since last check`;
          } else {
            deltaText = "\n**Delta:** No change since last check";
          }
        }

        // Save updated baseline
        store?.setSetting(
          cacheKey,
          JSON.stringify({
            timestamp: Date.now(),
            errorCount,
            errors: currentErrors,
          } satisfies DiagnosticsBaseline),
        );

        // Get active spec for file filtering
        const activeSpec = specStore?.getCurrentSpec(project) ?? null;
        const specFiles = activeSpec
          ? extractSpecFiles(activeSpec.planFile)
          : new Set<string>();

        // Partition errors: spec-relevant vs other
        const specErrors = currentErrors.filter((err) => {
          const relFile = err.file.replace(/^\.\//, "");
          if (specFiles.size === 0) return true;
          return [...specFiles].some((sf) => {
            const sfNorm = sf.replace(/^\.\//, "");
            return relFile.endsWith(sfNorm) || sfNorm.endsWith(relFile);
          });
        });
        const otherErrors = currentErrors.filter(
          (err) => !specErrors.includes(err),
        );

        // Build output
        const lines: string[] = [];
        if (errorCount === 0) {
          lines.push(`## TypeScript Diagnostics — 0 errors${deltaText}`);
          lines.push("", "No TypeScript errors found.");
        } else {
          const specLabel = activeSpec ? " (spec files)" : "";
          lines.push(
            `## TypeScript Diagnostics — ${errorCount} error${errorCount === 1 ? "" : "s"}${deltaText}`,
          );

          if (specErrors.length > 0) {
            lines.push(
              "",
              `### ${specErrors.length} error${specErrors.length === 1 ? "" : "s"} in spec-relevant files${specLabel}`,
            );
            for (const err of specErrors) {
              lines.push(`- \`${err.file}:${err.line}\` — ${err.message}`);
            }
          }

          if (otherErrors.length > 0) {
            const nFiles = countUniqueFiles(otherErrors);
            lines.push(
              "",
              `### ${otherErrors.length} other error${otherErrors.length === 1 ? "" : "s"} in ${nFiles} non-spec file${nFiles === 1 ? "" : "s"}`,
              "_Run `npx tsc --noEmit` for full details on non-spec errors._",
            );
          }
        }

        if (activeSpec) {
          lines.push("", `_Active spec: ${activeSpec.title}_`);
        }

        return mcpText(lines.join("\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(
          `Error running check_diagnostics: ${msg}\n\nFallback: run \`npx tsc --noEmit\` directly.`,
        );
      }
    },
  );
}

// --- quality_report ---

const ALL_CHECKS: CheckName[] = ["tsc", "eslint", "prettier"];

/** Sidecar first (warm LSP for tsc), in-process on sidecar failure. */
async function runViaSidecar(
  client: SidecarClient | null,
  signal: AbortSignal | undefined,
  req: QualityCheckRequest,
): Promise<QualityCheckResult> {
  // withAbort makes the tool return promptly on client cancellation even
  // if the underlying subprocess lingers (reaped by the sidecar's
  // runWithTimeout; the activeChecks/MAX_CONCURRENT guards release in a finally).
  if (client) {
    try {
      return await withAbort(signal, client.qualityCheck(req));
    } catch (err) {
      if (signal?.aborted) throw err;
      // Sidecar failed — fall back to direct
    }
  }
  return withAbort(signal, runQualityChecks(req));
}

function registerQualityReportTool(
  server: McpServer,
  client: SidecarClient | null,
): void {
  server.tool(
    "quality_report",
    "Run TypeScript, ESLint, and Prettier checks on a project or a single file. Project-wide (no `file`) is report-only: it lists unformatted files and real ESLint error/warning counts, top rules and locations, and never modifies anything. With `file`, ESLint --fix and Prettier --write are applied to that one file only (it must be inside the project). Uses the sidecar for incremental tsc with tsBuildInfo caching.",
    {
      project: z.string().describe("Absolute path to the project root"),
      file: z
        .string()
        .optional()
        .describe(
          "File for eslint/prettier, absolute or relative to `project` (must be inside it): auto-fixes only the given file; project-wide is report-only — when omitted, nothing is modified.",
        ),
      checks: z
        .array(z.enum(["tsc", "eslint", "prettier"]))
        .optional()
        .describe("Which checks to run. Default: all three."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Per-check timeout in milliseconds (default 30000)"),
    },
    async ({ project, file, checks, timeout_ms }, extra) => {
      try {
        const progressExtra = extra as ProgressExtra | undefined;
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        // D1: resolve (and refuse outside the project) before anything runs.
        const target = file ? resolveQualityTarget(project, file) : undefined;
        await emitProgress(progressExtra, {
          progress: 0,
          message: "running quality checks",
        });
        const requested = (checks as CheckName[] | undefined) ?? ALL_CHECKS;
        let result: QualityCheckResult;

        if (target) {
          result = await runViaSidecar(client, signal, {
            projectPath: project,
            filePath: target,
            checks: checks as CheckName[] | undefined,
            timeout: timeout_ms,
          });
        } else {
          // Project-wide: only tsc goes to the sidecar. eslint/prettier ALWAYS
          // run in-process, report-only — a ≤ v1.38 sidecar still in memory
          // would answer them with `eslint --fix .` / `prettier --write .`.
          const tsc: QualityCheckResult = requested.includes("tsc")
            ? await runViaSidecar(client, signal, {
                projectPath: project,
                filePath: undefined,
                checks: ["tsc"],
                timeout: timeout_ms,
              })
            : {};
          const lint = requested.filter((c) => c !== "tsc");
          const linted: QualityCheckResult = lint.length
            ? await withAbort(
                signal,
                runQualityChecks({
                  projectPath: project,
                  checks: lint,
                  timeout: timeout_ms,
                }),
              )
            : {};
          result = { tsc: tsc.tsc, ...linted };
        }
        await emitProgress(progressExtra, { progress: 1, message: "done" });

        return mcpText(formatQualityReport(project, target, result));
      } catch (err) {
        return mcpError("## Quality Report — Error\n", err);
      }
    },
  );
}
