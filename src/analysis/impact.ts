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
import type { SidecarClient } from "../sidecar/client.js";
import {
  extractSpecFiles,
  countLines,
  isExpectedFile,
  countImporters,
  type ChangedFile,
  type RiskLevel,
} from "./helpers.js";
import { buildImportGraph } from "./imports.js";
import { renderCallSites } from "./call-sites.js";
import {
  AgentReachSchema,
  isHighReach,
  isMediumReach,
  isReachRelevantPath,
  maxReach,
  resolveReach,
  type CallSite,
  type ReachProvider,
} from "./reach.js";

/**
 * @param specStore Direct SQLite access. `null` in production — see `client`.
 * @param reachProvider Optional external reach oracle.
 * @param client The sidecar. **Load-bearing.** `src/mcp/server.ts` sets
 *   `store = client ? null : ...` and production always has a client, so
 *   `specStore` is always `null` there. Without this parameter the active spec
 *   never resolved, `specFiles` was permanently empty, and every spec-aware
 *   branch below (`_Active spec:_`, the unexpected-file warning, the
 *   Expected/Unexpected summary lines, and the `hasUnexpected` HIGH trigger in
 *   `scoreRisk`) was dead code in the only configuration users ever run.
 */
export function registerImpactAnalysisTool(
  server: McpServer,
  specStore: SpecStore | null,
  reachProvider: ReachProvider | null = null,
  client: SidecarClient | null = null,
): void {
  server.tool(
    "impact_analysis",
    "Analyze the impact of changed files against the active spec. Reports expected vs unexpected changes, file length limit violations, and an overall risk score (LOW/MEDIUM/HIGH). More useful than `git diff --stat`: cross-references plan task files, checks Sentinal's 400-line limit, and scores risk.",
    {
      project: z.string().describe("Absolute path to the project root"),
      reach: AgentReachSchema.optional(),
    },
    async ({ project, reach }) => {
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

        // Get active spec task files. Direct store when there is no sidecar;
        // otherwise the sidecar, which owns the warm SQLite handle.
        //
        // NOTE: restoring this also restores `hasUnexpected` as a HIGH trigger,
        // so the observed HIGH rate will rise. That is the behaviour the tool
        // was always documented to have — not a regression.
        const activeSpec =
          specStore?.getCurrentSpec(project) ??
          (await resolveSpecViaClient(client, project));
        const specFiles = activeSpec
          ? extractSpecFiles(activeSpec.planFile)
          : new Set<string>();

        // One graph for the whole invocation — building it per file would
        // re-read the tree once per changed path.
        const graph = buildImportGraph(project);

        // Reach for the whole changeset, resolved once: agent-supplied →
        // provider → built-in. Rejected outright (rather than partially
        // applied) if the agent's map does not cover every changed TS file.
        const resolution = await resolveReach({
          project,
          changedRelPaths: [...allChangedRelPaths],
          fallbackModuleCount: graph.modules.size,
          agentReach: reach ?? null,
          provider: reachProvider,
        });
        if (!resolution.ok) return mcpText(resolution.error);

        // Analyze each changed file
        const changedFiles: ChangedFile[] = [];
        for (const relPath of allChangedRelPaths) {
          if (!isReachRelevantPath(relPath)) {
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
            resolution.overrides.get(relPath) ??
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
        const moduleCount = resolution.moduleCount;
        const risk = scoreRisk(changedFiles, specFiles, moduleCount);

        // Build output
        const lines = buildImpactOutput(
          risk,
          changedFiles,
          specFiles,
          activeSpec?.title ?? null,
          moduleCount,
          resolution.attribution,
          resolution.callSites,
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

/**
 * Resolve the active spec through the sidecar, degrading to "no spec" if it is
 * unreachable. A down sidecar must cost the report its spec half, never fail
 * the whole tool — the reach and length halves remain useful without it.
 */
async function resolveSpecViaClient(
  client: SidecarClient | null,
  project: string,
): Promise<{ title: string; planFile: string } | null> {
  if (!client) return null;
  try {
    return (await client.getCurrentSpec(project)) ?? null;
  } catch {
    return null;
  }
}

async function runGitDiff(project: string, cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: project, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.stdout.text();
}

// --- Risk scoring ---

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
  /**
   * Where the reach numbers came from. Empty for the built-in resolver, so
   * the default report is byte-unchanged; populated only when an agent
   * supplied `reach`, since a score computed from someone else's graph must
   * say so.
   */
  reachAttribution: string[] = [],
  /**
   * Evidence for the reach above — never an input to it. Empty for every
   * built-in run, so the default report is byte-unchanged.
   */
  callSites: CallSite[] = [],
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

  // Immediately after the reach block: reach is the count, call sites are the
  // evidence for it, so the two read together. Everything below stays where it
  // was, which matters because `impact.test.ts` asserts on these bytes.
  lines.push(...renderCallSites(callSites));

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
  lines.push(...reachAttribution);

  return lines.join("\n");
}
