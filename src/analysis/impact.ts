/**
 * impact_analysis MCP tool
 *
 * Extracted from `mcp-tools.ts`, which had reached 602 lines — over Sentinal's
 * own 600-line hard block, making the risk formula at its core uneditable.
 *
 * Analyzes changed files against the active spec: expected vs unexpected
 * changes, file-length warnings, and an overall risk score.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";
import { mcpText } from "../mcp/helpers.js";
import type { SpecStore } from "../spec/store.js";
import {
  extractSpecFiles,
  countLines,
  isExpectedFile,
  countImporters,
  type ChangedFile,
  type RiskLevel,
} from "./helpers.js";
import { buildImportGraph } from "./imports.js";

/**
 * Optional source of a better reach number than the built-in resolver can
 * produce — e.g. a real call graph or an index built by an external tool.
 *
 * Sentinal never depends on one. When no provider is supplied, when `reachOf`
 * returns `null`, or when it throws, the built-in parsed-import resolver
 * answers instead and the output is byte-identical to having no seam at all.
 * Nothing in this repo wires a specific tool into it.
 */
export interface ReachProvider {
  /** Modules reaching `relPath`; `null` defers to the built-in resolver. */
  reachOf(
    relPath: string,
    project: string,
  ): number | null | Promise<number | null>;
  /** Size of the universe the provider measures against, if it differs. */
  moduleCount?(project: string): number | Promise<number>;
}

/**
 * Ask the provider, tolerating absence, deferral and failure.
 * Returns `null` whenever the built-in resolver should answer.
 */
async function providerReach(
  provider: ReachProvider | null,
  relPath: string,
  project: string,
): Promise<number | null> {
  if (!provider) return null;
  try {
    const value = await provider.reachOf(relPath, project);
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  } catch {
    // A broken external graph must never break the tool.
    return null;
  }
}

async function providerModuleCount(
  provider: ReachProvider | null,
  project: string,
  fallback: number,
): Promise<number> {
  if (!provider?.moduleCount) return fallback;
  try {
    const value = await provider.moduleCount(project);
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

export function registerImpactAnalysisTool(
  server: McpServer,
  specStore: SpecStore | null,
  reachProvider: ReachProvider | null = null,
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
          return mcpText(
            "## Impact Analysis\n\n0 files changed. Nothing to analyze.",
          );
        }

        // Get active spec task files
        const activeSpec = specStore?.getCurrentSpec(project) ?? null;
        const specFiles = activeSpec
          ? extractSpecFiles(activeSpec.planFile)
          : new Set<string>();

        // One graph for the whole invocation — building it per file would
        // re-read the tree once per changed path.
        const graph = buildImportGraph(project);

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
          const importerCount =
            (await providerReach(reachProvider, relPath, project)) ??
            countImporters(relPath, project, graph);
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
        const moduleCount = await providerModuleCount(
          reachProvider,
          project,
          graph.modules.size,
        );
        const risk = scoreRisk(changedFiles, specFiles, moduleCount);

        // Build output
        const lines = buildImpactOutput(
          risk,
          changedFiles,
          specFiles,
          activeSpec?.title ?? null,
          moduleCount,
        );
        return mcpText(lines);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(
          `Error running impact_analysis: ${msg}\n\nFallback: run \`git diff --stat HEAD\` directly.`,
        );
      }
    },
  );
}

async function runGitDiff(project: string, cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: project, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.stdout.text();
}

// --- Risk scoring ---

/**
 * Reach thresholds.
 *
 * Each tier needs BOTH an absolute floor and a share of the module tree.
 *
 * The absolute floor alone is not enough: transitive closure saturates in any
 * connected codebase. Measured on this repo (334 modules) the reach
 * distribution is sharply bimodal — p50 = 10 but p75 = 82 — so a flat
 * threshold of 8 marks roughly half of all files HIGH, which reproduces the
 * original defect with a different cause.
 *
 * The share alone is not enough either: in a 3-file project one importer is
 * 33% of the tree and would score HIGH.
 *
 * Together they give 60% LOW / 18% MEDIUM / 22% HIGH on this repo, with
 * `src/runtime/ownership.ts` (the case that motivated this plan) landing HIGH
 * on reach — 89 modules — rather than on being two lines over a line limit.
 */
export const HIGH_REACH_MIN = 8;
export const HIGH_REACH_SHARE = 0.25;
/** Absolute floor deliberately identical to the previous `importerCount > 3`. */
export const MEDIUM_REACH_MIN = 4;
export const MEDIUM_REACH_SHARE = 0.1;

export function maxReach(changedFiles: ChangedFile[]): number {
  return changedFiles.reduce((m, f) => Math.max(m, f.importerCount), 0);
}

export function isHighReach(reach: number, moduleCount: number): boolean {
  return reach >= HIGH_REACH_MIN && reach >= moduleCount * HIGH_REACH_SHARE;
}

export function isMediumReach(reach: number, moduleCount: number): boolean {
  return reach >= MEDIUM_REACH_MIN && reach >= moduleCount * MEDIUM_REACH_SHARE;
}

/**
 * Score the change.
 *
 * Previously: `if (hasUnexpected || hasLimitViolation) HIGH; else if reach > 3
 * MEDIUM`. That made length — a style signal — dominant, and capped reach, the
 * only structural signal, below it: structural impact could never reach HIGH.
 *
 * Now length contributes **nothing** to the score. It is still reported as a
 * warning (see `buildImpactOutput`); it simply no longer decides the risk.
 * `hasUnexpected` is untouched — that signal is about plan compliance and was
 * always correct.
 */
export function scoreRisk(
  changedFiles: ChangedFile[],
  specFiles: Set<string>,
  moduleCount: number,
): RiskLevel {
  const hasUnexpected =
    specFiles.size > 0 && changedFiles.some((f) => !f.isExpected);
  const reach = maxReach(changedFiles);

  if (hasUnexpected || isHighReach(reach, moduleCount)) return "HIGH";
  if (isMediumReach(reach, moduleCount)) return "MEDIUM";
  return "LOW";
}

export function buildImpactOutput(
  risk: RiskLevel,
  changedFiles: ChangedFile[],
  specFiles: Set<string>,
  specTitle: string | null,
  moduleCount = 0,
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

  // Name the reach whenever it is what moved the score, so a HIGH is never
  // explained by the line count alone.
  const reaching = changedFiles
    .filter((f) => isMediumReach(f.importerCount, moduleCount))
    .sort((a, b) => b.importerCount - a.importerCount);
  if (reaching.length > 0) {
    lines.push("", "### Import Reach");
    for (const f of reaching) {
      const label = isHighReach(f.importerCount, moduleCount)
        ? "HIGH REACH"
        : "reach";
      const share = moduleCount
        ? ` — ${Math.round((f.importerCount / moduleCount) * 100)}% of ${moduleCount} modules`
        : "";
      lines.push(
        `- **${label}: \`${f.relPath}\` is reached by ${f.importerCount} module${f.importerCount === 1 ? "" : "s"}** (transitive)${share}`,
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
