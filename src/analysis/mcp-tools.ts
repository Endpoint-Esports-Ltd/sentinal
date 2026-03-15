/**
 * Analysis MCP Tools
 *
 * Registers spec-aware analysis tools on an MCP server.
 * Provides:
 *   - check_diagnostics: tsc with delta tracking and spec-file filtering
 *   - impact_analysis: change impact with plan-context cross-referencing and risk scoring
 *
 * Unlike raw bash commands, these tools leverage Sentinal's persistent state:
 *   - check_diagnostics caches tsc baselines in SQLite for delta tracking
 *   - impact_analysis cross-references git diff against the active spec's task files
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import type { SidecarClient } from "../sidecar/client.js";
import {
  runQualityChecks,
  type QualityCheckResult,
  type ToolResult,
  type CheckName,
} from "../sidecar/quality-routes.js";
import {
  projectHash,
  parseTscOutput,
  extractSpecFiles,
  countLines,
  isExpectedFile,
  countImporters,
  countUniqueFiles,
  type DiagnosticsBaseline,
  type ChangedFile,
  type RiskLevel,
} from "./helpers.js";

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
  registerImpactAnalysisTool(server, client, effectiveStore, specStore);
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
        const proc = Bun.spawn(
          ["npx", "tsc", "--noEmit", "--pretty", "false"],
          {
            cwd: project,
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        const timeoutPromise = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), timeoutMs),
        );

        const result = await Promise.race([proc.exited, timeoutPromise]);

        if (result === "timeout") {
          proc.kill();
          const partialStderr = await proc.stderr.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `TIMEOUT: tsc did not complete within ${timeoutMs}ms. Run \`npx tsc --noEmit\` directly for full output.${partialStderr ? `\n\nPartial stderr:\n${partialStderr}` : ""}`,
              },
            ],
          };
        }

        const tscOutput = await proc.stdout.text();
        const currentErrors = parseTscOutput(tscOutput);
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

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error running check_diagnostics: ${msg}\n\nFallback: run \`npx tsc --noEmit\` directly.`,
            },
          ],
        };
      }
    },
  );
}

// --- impact_analysis ---

function registerImpactAnalysisTool(
  server: McpServer,
  _client: SidecarClient | null,
  _store: MemoryStore | null,
  specStore: SpecStore | null,
): void {
  server.tool(
    "impact_analysis",
    "Analyze the impact of changed files against the active spec. Reports expected vs unexpected changes, file length limit violations, and an overall risk score (LOW/MEDIUM/HIGH). More useful than `git diff --stat`: cross-references plan task files, checks Sentinal's 400-line limit, and scores risk.",
    {
      project: z.string().describe("Absolute path to the project root"),
    },
    async ({ project }) => {
      try {
        // Get changed files (unstaged + staged)
        const [diffOut, diffCachedOut] = await Promise.all([
          runGitDiff(project, ["git", "diff", "--name-only", "HEAD"]),
          runGitDiff(project, ["git", "diff", "--name-only", "--cached"]),
        ]);

        const allChangedRelPaths = new Set<string>(
          [...diffOut.split("\n"), ...diffCachedOut.split("\n")]
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        );

        if (allChangedRelPaths.size === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "## Impact Analysis\n\n0 files changed. Nothing to analyze.",
              },
            ],
          };
        }

        // Get active spec task files
        const activeSpec = specStore?.getCurrentSpec(project) ?? null;
        const specFiles = activeSpec
          ? extractSpecFiles(activeSpec.planFile)
          : new Set<string>();

        // Analyze each changed file
        const changedFiles: ChangedFile[] = [];
        for (const relPath of allChangedRelPaths) {
          const isTsFile =
            relPath.endsWith(".ts") ||
            relPath.endsWith(".js") ||
            relPath.endsWith(".tsx");
          if (!isTsFile) {
            changedFiles.push({
              path: join(project, relPath),
              relPath,
              isExpected: isExpectedFile(relPath, specFiles),
              lineCount: 0,
              overLimit: false,
              importerCount: 0,
            });
            continue;
          }
          const fullPath = join(project, relPath);
          const lineCount = countLines(fullPath);
          const importerCount = await countImporters(relPath, project);
          changedFiles.push({
            path: fullPath,
            relPath,
            isExpected: isExpectedFile(relPath, specFiles),
            lineCount,
            overLimit: lineCount > 400,
            importerCount,
          });
        }

        // Compute risk level
        const hasUnexpected =
          specFiles.size > 0 && changedFiles.some((f) => !f.isExpected);
        const hasLimitViolation = changedFiles.some((f) => f.overLimit);
        let risk: RiskLevel = "LOW";
        if (hasUnexpected || hasLimitViolation) risk = "HIGH";
        else if (changedFiles.some((f) => f.importerCount > 3)) risk = "MEDIUM";

        // Build output
        const lines = buildImpactOutput(
          risk,
          changedFiles,
          specFiles,
          activeSpec?.title ?? null,
        );
        return { content: [{ type: "text" as const, text: lines }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error running impact_analysis: ${msg}\n\nFallback: run \`git diff --stat HEAD\` directly.`,
            },
          ],
        };
      }
    },
  );
}

async function runGitDiff(project: string, cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: project, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.stdout.text();
}

// --- quality_report ---

function registerQualityReportTool(
  server: McpServer,
  client: SidecarClient | null,
): void {
  server.tool(
    "quality_report",
    "Run TypeScript, ESLint, and Prettier quality checks on a project or single file. Returns structured results with timing info. Uses the sidecar for incremental tsc with tsBuildInfo caching. More useful than running tools manually: returns all checks in one call with auto-fix for eslint/prettier.",
    {
      project: z.string().describe("Absolute path to the project root"),
      file: z
        .string()
        .optional()
        .describe(
          "Specific file to check (eslint/prettier only). If omitted, project-wide.",
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
    async ({ project, file, checks, timeout_ms }) => {
      try {
        let result: QualityCheckResult;

        // Try sidecar first, fall back to direct execution
        if (client) {
          try {
            result = await client.qualityCheck({
              projectPath: project,
              filePath: file,
              checks,
              timeout: timeout_ms,
            });
          } catch {
            // Sidecar failed — fall back to direct
            result = await runQualityChecks({
              projectPath: project,
              filePath: file,
              checks: checks as CheckName[] | undefined,
              timeout: timeout_ms,
            });
          }
        } else {
          result = await runQualityChecks({
            projectPath: project,
            filePath: file,
            checks: checks as CheckName[] | undefined,
            timeout: timeout_ms,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: formatQualityReport(project, file, result),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `## Quality Report — Error\n\n${msg}`,
            },
          ],
        };
      }
    },
  );
}

function formatQualityReport(
  project: string,
  file: string | undefined,
  result: QualityCheckResult,
): string {
  const lines: string[] = [
    "## Quality Report",
    `**Project:** ${project}`,
    file ? `**File:** ${file}` : "**Scope:** Project-wide",
    "",
  ];

  if (result.tsc) {
    const t = result.tsc;
    const meta = [
      `${(t.durationMs / 1000).toFixed(1)}s`,
      t.incremental ? "incremental" : "full",
      t.timedOut ? "TIMED OUT" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`### TypeScript (${meta})`);
    if (t.ok) {
      lines.push("- 0 errors");
    } else {
      lines.push(
        `- ${t.errors.length} error${t.errors.length === 1 ? "" : "s"}`,
      );
      for (const e of t.errors.slice(0, 10)) {
        lines.push(`  - ${e}`);
      }
      if (t.errors.length > 10)
        lines.push(`  - ... and ${t.errors.length - 10} more`);
    }
    lines.push("");
  }

  if (result.eslint) {
    const t = result.eslint;
    const meta = [
      `${(t.durationMs / 1000).toFixed(1)}s`,
      t.autoFixed ? "auto-fixed" : "",
      t.timedOut ? "TIMED OUT" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`### ESLint (${meta})`);
    if (t.ok) {
      lines.push(t.autoFixed ? "- Auto-fixed issues" : "- No issues");
    } else {
      lines.push(
        `- ${t.errors.length} error${t.errors.length === 1 ? "" : "s"}`,
      );
      for (const e of t.errors.slice(0, 5)) {
        lines.push(`  - ${e}`);
      }
    }
    lines.push("");
  }

  if (result.prettier) {
    const t = result.prettier;
    const meta = [
      `${(t.durationMs / 1000).toFixed(1)}s`,
      t.autoFixed ? "auto-fixed" : "",
      t.timedOut ? "TIMED OUT" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`### Prettier (${meta})`);
    if (t.ok) {
      lines.push(
        t.autoFixed ? "- Formatted files" : "- All files formatted correctly",
      );
    } else {
      lines.push(
        `- ${t.errors.length} issue${t.errors.length === 1 ? "" : "s"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildImpactOutput(
  risk: RiskLevel,
  changedFiles: ChangedFile[],
  specFiles: Set<string>,
  specTitle: string | null,
): string {
  const riskSuffix =
    risk === "MEDIUM"
      ? " (review recommended)"
      : risk === "HIGH"
        ? " (action required)"
        : "";
  const lines: string[] = [
    `## Impact Analysis — Risk: **${risk}**${riskSuffix}`,
    "",
    `**${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed**`,
  ];
  if (specTitle) lines.push(`_Active spec: ${specTitle}_`);

  lines.push("", "### Changed Files");
  const expectedFiles = changedFiles.filter(
    (f) => f.isExpected || specFiles.size === 0,
  );
  const unexpectedFiles = changedFiles.filter(
    (f) => !f.isExpected && specFiles.size > 0,
  );

  if (expectedFiles.length > 0) {
    lines.push("");
    if (specFiles.size > 0) lines.push("**Expected (in spec):**");
    for (const f of expectedFiles) {
      const linePart = f.lineCount > 0 ? ` — ${f.lineCount} lines` : "";
      const importPart =
        f.importerCount > 0
          ? ` — ${f.importerCount} importer${f.importerCount === 1 ? "" : "s"}`
          : "";
      lines.push(`- \`${f.relPath}\`${linePart}${importPart}`);
    }
  }
  if (unexpectedFiles.length > 0) {
    lines.push("");
    for (const f of unexpectedFiles) {
      const linePart = f.lineCount > 0 ? ` (${f.lineCount} lines)` : "";
      const importPart =
        f.importerCount > 0
          ? `, ${f.importerCount} importer${f.importerCount === 1 ? "" : "s"}`
          : "";
      lines.push(
        `- ⚠️ **WARNING: \`${f.relPath}\` modified but not listed in any task's Files section**${linePart}${importPart}`,
      );
    }
  }

  const overLimitFiles = changedFiles.filter((f) => f.overLimit);
  if (overLimitFiles.length > 0) {
    lines.push("", "### File Length Warnings");
    for (const f of overLimitFiles) {
      lines.push(
        `- ⚠️ **WARNING: \`${f.relPath}\` is ${f.lineCount} lines (over 400-line limit)**`,
      );
    }
  }

  lines.push(
    "",
    "### Summary",
    `- Risk: **${risk}**`,
    `- Files changed: ${changedFiles.length}`,
  );
  if (specFiles.size > 0) {
    lines.push(`- Expected (in spec): ${expectedFiles.length}`);
    if (unexpectedFiles.length > 0)
      lines.push(`- Unexpected (not in spec): ${unexpectedFiles.length}`);
  }
  if (overLimitFiles.length > 0)
    lines.push(`- Over 400-line limit: ${overLimitFiles.length}`);

  return lines.join("\n");
}
