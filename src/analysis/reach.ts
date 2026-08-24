/**
 * Reach resolution and reach thresholds for `impact_analysis`.
 *
 * Split out of `impact.ts` as a pure move — no behaviour change — so that the
 * reach concerns have room to grow without pushing `impact.ts` past Sentinal's
 * own 400-line warn.
 */

import { z } from "zod";
import type { ChangedFile } from "./helpers.js";

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
export async function providerReach(
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

export async function providerModuleCount(
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

// --- Agent-supplied reach ---

/**
 * The agent-passable equivalent of `ReachProvider`.
 *
 * `ReachProvider.reachOf` is a *function*, and MCP tool arguments are JSON —
 * an agent physically cannot pass a closure, so that seam is unreachable in
 * production. This is the data-shaped version an agent can actually send.
 *
 * ⛔ `moduleCount` is mandatory and is a single report-level scalar: `scoreRisk`
 * compares one `maxReach` against it and every line of the Import Reach section
 * divides by it. Reach numbers without their universe are unscoreable, and reach
 * numbers from a *different* universe are worse than none — they silently
 * mis-score every file in the report.
 */
export const AgentReachSchema = z
  .object({
    moduleCount: z
      .number()
      .int()
      .positive()
      .describe(
        "Total modules in the universe these reach numbers were measured against",
      ),
    files: z
      .record(z.string(), z.number().int().nonnegative())
      .describe(
        "Repo-relative path -> modules transitively reaching it. Must cover EVERY changed .ts/.tsx/.js file, and every value must be <= moduleCount (a larger value proves the two came from different metrics).",
      ),
    source: z
      .string()
      .optional()
      .describe(
        "Tool that produced these numbers, e.g. 'codebase-memory-mcp trace_path'",
      ),
  })
  .refine(
    (r) => Object.values(r.files).every((v) => v <= r.moduleCount),
    "a reach value exceeds moduleCount — the two came from different metrics",
  )
  .describe(
    "Reach measured by an external code-graph tool. All-or-nothing: `files` must cover every changed .ts/.tsx/.js file or the whole object is rejected, because a partial map would score the remaining files' built-in counts against your moduleCount.",
  );

export type AgentReach = z.infer<typeof AgentReachSchema>;

/**
 * Does this changed path ever consult reach?
 *
 * `impact.ts` short-circuits non-TS paths with `importerCount: 0`, so requiring
 * the agent to cover them would reject every changeset containing a `.md`.
 * Shared with `impact.ts` so the short-circuit and the coverage rule cannot
 * drift apart.
 */
export function isReachRelevantPath(relPath: string): boolean {
  return (
    relPath.endsWith(".ts") ||
    relPath.endsWith(".js") ||
    relPath.endsWith(".tsx")
  );
}

export interface ResolveReachOptions {
  project: string;
  /** Every changed path, TS and not. */
  changedRelPaths: string[];
  /** Built-in universe size, used when no better one is available. */
  fallbackModuleCount: number;
  agentReach?: AgentReach | null;
  provider?: ReachProvider | null;
}

export type ReachResolution =
  | {
      ok: true;
      moduleCount: number;
      /** relPath -> reach. Absent means "use the built-in resolver". */
      overrides: Map<string, number>;
      /** Report lines naming the source and coverage; empty when built-in. */
      attribution: string[];
    }
  | { ok: false; error: string };

/**
 * Resolve reach for the whole changeset.
 *
 * **Precedence — three tiers, applied to the entire changeset, never mixed:**
 *
 *   1. Validated agent-supplied `reach` (all-or-nothing — see below)
 *   2. `ReachProvider` (`providerReach` / `providerModuleCount`)
 *   3. Built-in parsed-import resolver (`countImporters` / `graph.modules.size`)
 *
 * This ordering is a decision, not an accident: the agent's tool is the most
 * informed source available and it arrives with its own universe size, so it
 * must outrank the in-process seam. Tiers 2 and 3 *do* mix per-file (a provider
 * returning `null` defers for that file only) — that is safe because
 * `providerModuleCount` falls back to the built-in universe, so both tiers
 * measure against the same tree. Tier 1 cannot mix, because the agent's
 * universe is by definition a different tree.
 */
export async function resolveReach(
  opts: ResolveReachOptions,
): Promise<ReachResolution> {
  const {
    project,
    changedRelPaths,
    fallbackModuleCount,
    agentReach = null,
    provider = null,
  } = opts;
  const required = changedRelPaths.filter(isReachRelevantPath);

  // Tier 1 — agent-supplied, all-or-nothing.
  if (agentReach) return applyAgentReach(agentReach, required);

  // Tiers 2 and 3.
  const overrides = new Map<string, number>();
  for (const relPath of required) {
    const value = await providerReach(provider, relPath, project);
    if (value !== null) overrides.set(relPath, value);
  }
  return {
    ok: true,
    moduleCount: await providerModuleCount(
      provider,
      project,
      fallbackModuleCount,
    ),
    overrides,
    attribution: [],
  };
}

/**
 * Accept the agent's map only if it covers the whole changeset.
 *
 * Re-checks the invariants `AgentReachSchema` already enforces. That is
 * deliberate, not redundant: `resolveReach` is reachable from any in-process
 * caller (and from the tests) without passing through MCP's zod validation, and
 * an unchecked bad value here mis-scores the report rather than erroring.
 */
function applyAgentReach(
  reach: AgentReach,
  required: string[],
): ReachResolution {
  const { moduleCount, files } = reach;
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) {
    return reject([
      `**Invalid \`moduleCount\`:** \`${moduleCount}\` — must be a finite number greater than 0.`,
    ]);
  }

  const missing = required.filter((p) => !Object.hasOwn(files, p));
  const invalid = Object.entries(files).filter(
    ([, v]) => !Number.isFinite(v) || v < 0 || v > moduleCount,
  );
  if (missing.length > 0 || invalid.length > 0) {
    return reject(
      buildRejectionDetail(missing, invalid, required, files, moduleCount),
    );
  }

  const overrides = new Map(required.map((p) => [p, files[p]]));
  const attribution = [
    `- Reach: agent-supplied — ${overrides.size} of ${required.length} changed TS file${required.length === 1 ? "" : "s"} covered, universe ${moduleCount} modules`,
  ];
  if (reach.source) attribution.push(`- Reach source: ${reach.source}`);
  return { ok: true, moduleCount, overrides, attribution };
}

function buildRejectionDetail(
  missing: string[],
  invalid: [string, number][],
  required: string[],
  files: Record<string, number>,
  moduleCount: number,
): string[] {
  const detail: string[] = [];
  if (missing.length > 0) {
    detail.push(
      `**Missing from \`files\`** — ${required.length - missing.length} of ${required.length} changed TS files covered:`,
      ...bullets(missing),
    );
    // Keys that match nothing are the tell for a relative-vs-absolute mistake,
    // so they are only worth surfacing alongside an actual gap.
    const unmatched = Object.keys(files).filter((k) => !required.includes(k));
    if (unmatched.length > 0) {
      detail.push(
        "",
        "**Keys in `files` matching no changed file:**",
        ...bullets(unmatched),
      );
    }
  }
  if (invalid.length > 0) {
    if (detail.length > 0) detail.push("");
    detail.push(
      "**Invalid values in `files`** (each must be a finite integer between 0 and `moduleCount`):",
      ...invalid.map(
        ([k, v]) => `- \`${k}\`: ${v} (moduleCount ${moduleCount})`,
      ),
    );
  }
  return detail;
}

function bullets(paths: string[], cap = 10): string[] {
  const shown = paths.slice(0, cap).map((p) => `- \`${p}\``);
  if (paths.length > cap) shown.push(`- …and ${paths.length - cap} more`);
  return shown;
}

function reject(detail: string[]): ReachResolution {
  return {
    ok: false,
    error: [
      "## Impact Analysis — supplied `reach` rejected",
      "",
      "Nothing was scored. Applying this map would have measured some files against your module universe and the rest against Sentinal's built-in one, silently mis-scoring every line of the report.",
      "",
      ...detail,
      "",
      "`files` keys must be **repo-relative** paths exactly as `git diff --name-only` prints them (`src/a.ts`, not `/abs/path/src/a.ts`), must cover every changed `.ts`/`.tsx`/`.js` file, and every value must be measured against the same `moduleCount`.",
      "",
      "Fix the map and retry, or omit `reach` entirely to use Sentinal's built-in import graph.",
    ].join("\n"),
  };
}
