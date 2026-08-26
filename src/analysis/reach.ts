/**
 * Reach resolution and reach thresholds for `impact_analysis`.
 *
 * Split out of `impact.ts` as a pure move — no behaviour change — so that the
 * reach concerns have room to grow without pushing `impact.ts` past Sentinal's
 * own 400-line warn.
 */

import { z } from "zod";
import type { ChangedFile } from "./helpers.js";
import {
  buildAttribution,
  CallSiteSchema,
  filesField,
  normalizeReachSources,
  ReachSourceSchema,
  rejectReach,
  selectPrimaryIndex,
  validateSource,
} from "./reach-sources.js";
import type { CallSite } from "./reach-sources.js";

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
 * connected codebase. The reach distribution is sharply bimodal — p50 = 10 but
 * p75 = 91 — so a flat threshold of 8 alone marks 110 of 350 modules HIGH,
 * 58% of the non-test source files, which reproduces the original defect with
 * a different cause.
 *
 * ⛔ **Those percentiles come from a different population than the divisor.**
 * The divisor in every share below is `graph.modules.size` — all 350 modules,
 * tests included. The percentiles are over the 190 **non-test source** modules
 * only; across all 350 the p50 is 1, because 160 test files are imported by
 * nothing. `ec642c6`'s "334 modules, p50 = 10, p75 = 82" quoted one of each
 * without saying which, so the figures look wrong when someone re-derives them.
 *
 * The share alone is not enough either: in a 3-file project one importer is
 * 33% of the tree and would score HIGH.
 *
 * Together they give 61.6% LOW / 12.1% MEDIUM / 26.3% HIGH over non-test
 * source, with `src/runtime/ownership.ts` (the case that motivated the fix)
 * landing HIGH on reach — 98 modules, 28% — rather than on being two lines
 * over a line limit.
 *
 * **Re-measured 2026-08-26 and left unchanged** — run
 * `bun scripts/measure-reach-thresholds.ts`; the verdict is recorded in
 * `docs/plans/2026-08-24-code-graph-impact-planning.md`. It found the floor
 * **inert on this repo**: floors of 4, 8, 16 and 32 produce an identical HIGH
 * rate at every share >= 10%, because no module sits between the floor and the
 * share cut. That is the 3-file argument working as intended, not dead code —
 * **do not delete the floor because it does nothing here.**
 *
 * ⚠️ **Those rates are the reach signal's, NOT `impact_analysis`'s HIGH rate.**
 * `scoreRisk` is `hasUnexpected || isHighReach(...)`, so reach is consulted
 * only once plan compliance has declined to fire — and the same 2026-08-26 run
 * measured `hasUnexpected` firing on **45.5%** of real changesets (source,
 * minus generated), **90.0%** on the raw arm. These cutoffs therefore decide
 * HIGH for a minority of production runs; do not read a HIGH as evidence that
 * reach produced it. That follows from Task 1 restoring a genuinely dead
 * trigger and is not a threshold defect — no cutoff change can move it
 * (loosening leaves `hasUnexpected` firing; tightening makes it worse). **The
 * lever is `hasUnexpected`'s standing inside `scoreRisk` in `impact.ts`, and is
 * deliberately deferred to its own spec** (Task 11 outcome in
 * `docs/plans/2026-08-24-code-graph-impact-planning.md`). Do not retune here in
 * compensation.
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

export type { CallSite } from "./reach-sources.js";

/**
 * The agent-passable equivalent of `ReachProvider`.
 *
 * `ReachProvider.reachOf` is a *function*, and MCP tool arguments are JSON —
 * an agent physically cannot pass a closure, so that seam is unreachable in
 * production. This is the data-shaped version an agent can actually send.
 *
 * ⛔ **A reach number and its universe must travel together, and exactly one
 * pair may score.** Reach numbers without a universe are unscoreable, and reach
 * numbers divided by a *different* source's universe are worse than none — they
 * silently mis-score every file in the report. That argument is unchanged; what
 * changed is where the universe lives. `moduleCount` is now per-source, so
 * supplying a second tool can no longer mis-pair the first tool's numbers.
 *
 * Per-source universes fix pairing but do **not** make the resulting shares
 * comparable. A module-level source (89/334 = 26.6% → HIGH) and a symbol-level
 * source (200/8440 = 2.4% → LOW) can describe the same file, both correctly.
 * Max-of-shares means installing a server can only raise the verdict, min only
 * lower it, and declaration order is arbitrary — in every variant the risk
 * score for identical code becomes a function of which servers happen to be
 * installed. The 25% cutoff was moreover derived from this repo's *module*
 * distribution (p50 = 10/334, p75 = 82/334); nothing establishes that it means
 * anything in a symbol universe.
 *
 * So: exactly one source scores (`primary`, else the first). The rest are
 * accepted for attribution and call sites and rendered explicitly as unscored.
 *
 * Both shapes are accepted, and the single-object one is normalised to a
 * one-element list by `normalizeReachSources`. That is not politeness: the
 * single-object form is what the already-shipped `mcp-servers.md` documents.
 */
export const AgentReachSchema = z
  .object({
    sources: z
      .array(ReachSourceSchema)
      .optional()
      .describe(
        "Multi-source form: one entry per code-graph tool, each carrying its own universe. Exactly one source is scored; the others are reporting-only. Must not be empty, and must not be combined with the single-source form.",
      ),
    moduleCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Single-source form: total modules in the universe these reach numbers were measured against. Supply together with `files`, and not alongside `sources`.",
      ),
    files: filesField
      .optional()
      .describe(
        `Single-source form: ${filesField.description} Supply together with moduleCount, and not alongside \`sources\`.`,
      ),
    source: z
      .string()
      .optional()
      .describe(
        "Single-source form: name of the tool that produced these numbers, e.g. '<server> <tool>'.",
      ),
    callSites: z
      .array(CallSiteSchema)
      .optional()
      .describe(
        "Evidence only — call sites are reported alongside the analysis and are NEVER scored. They cannot move the risk verdict, and they do not substitute for reach. Requires reach to be supplied as well.",
      ),
  })
  // ⛔ D1's last hole. Without `.strict()` zod SILENTLY STRIPS unknown keys, so
  // `{primary: true, sources: [module, symbol]}` — `primary` hoisted out of the
  // entry, an easy slip given the two documented shapes sit side by side in
  // `mcp-servers.md` — loses `primary` before `.refine()` or
  // `selectPrimaryIndex` can see it, and index 0 scores. That is a verdict
  // decided by declaration order: exactly what D1 exists to eliminate, and a
  // silent wrong answer rather than an error. Rejecting is strictly better —
  // the agent is told to re-nest the key instead of being handed the other
  // source's share. Applied BEFORE the `.refine()` chain because in zod 4
  // `.strict()` lives on `ZodObject`; it leaves `.shape` intact, so the
  // shape-derived bindings in `sync-graph-tools.test.ts` still resolve.
  .strict()
  // Exactly one of the two shapes. `!==` on two booleans is XOR.
  .refine(
    (r) =>
      (r.sources !== undefined) !==
      (r.moduleCount !== undefined || r.files !== undefined),
    "supply either `sources` (multi-source form) or `moduleCount` + `files` (single-source form) — not both, and not neither",
  )
  .refine(
    (r) =>
      r.sources !== undefined ||
      (r.moduleCount !== undefined && r.files !== undefined),
    "`moduleCount` and `files` must be supplied together — a reach number without its universe is unscoreable",
  )
  .refine(
    (r) => (r.sources?.length ?? 1) > 0,
    "`sources` must not be empty — omit `reach` entirely to use the built-in import graph",
  )
  .refine(
    (r) => (r.sources ?? []).filter((s) => s.primary).length <= 1,
    "at most one source may be marked `primary` — two primaries would make the scored source depend on declaration order",
  )
  // Reuses the same normalisation the handler runs, so the bound is checked
  // against each source's OWN universe in both shapes and cannot drift.
  .refine(
    (r) =>
      normalizeReachSources(r).every((s) =>
        Object.values(s.files).every((v) => v <= (s.moduleCount ?? Infinity)),
      ),
    "a reach value exceeds its own source's moduleCount — the two came from different metrics",
  )
  .describe(
    "Reach measured by external code-graph tool(s). Supply EITHER `sources` (one entry per tool, each with its own universe) OR the single-source form `moduleCount` + `files` — not both, not neither. Exactly one source is scored: the one marked `primary`, or the first if none is marked; every other source is accepted for reporting only and is rendered explicitly as unscored, because shares measured in different universes are not commensurable and a risk verdict must not depend on which servers happen to be installed. All-or-nothing coverage is enforced per source: the scored source must cover every changed .ts/.tsx/.js file or the whole object is rejected, because a partial map would score the remaining files' built-in counts against your moduleCount; a reporting-only source that fails coverage is dropped by name instead, leaving the verdict unchanged. Unknown top-level keys are REJECTED rather than ignored: `primary` belongs inside a `sources[]` entry, and silently dropping a mis-nested one would let the first source score instead of the one you marked.",
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
      /** The **primary** source's universe. Never a blend of several. */
      moduleCount: number;
      /** relPath -> reach. Absent means "use the built-in resolver". */
      overrides: Map<string, number>;
      /** Report lines naming the source and coverage; empty when built-in. */
      attribution: string[];
      /** Evidence only — never consulted by `scoreRisk`. */
      callSites: CallSite[];
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
 * universe is by definition a different tree — and, within tier 1, the several
 * agent sources cannot mix with each other for exactly the same reason.
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
    callSites: [],
  };
}

/**
 * Accept the agent's sources, scoring from exactly one of them.
 *
 * ⛔ D1 — the primary alone produces `moduleCount` and `overrides`, which are
 * the only things `scoreRisk` can see. Non-primary sources reach the output
 * through `attribution` and nothing else, so no arrangement of them can move a
 * verdict. Coverage is checked per source: a reporting-only source that fails
 * is dropped by name, while a failing **primary** rejects the whole call —
 * because scoring a partial primary is the silent mis-scoring all-or-nothing
 * exists to prevent.
 */
function applyAgentReach(
  reach: AgentReach,
  required: string[],
): ReachResolution {
  const sources = normalizeReachSources(reach);
  if (sources.length === 0) {
    return {
      ok: false,
      error: rejectReach([
        "**No reach sources supplied** — `sources` was empty. Omit `reach` entirely to use Sentinal's built-in import graph.",
      ]),
    };
  }

  const primaryIndex = selectPrimaryIndex(sources);
  const results = sources.map((s) => validateSource(s, required));
  const primary = results[primaryIndex];
  if (!primary.ok) return { ok: false, error: rejectReach(primary.detail) };

  return {
    ok: true,
    moduleCount: primary.moduleCount,
    overrides: primary.overrides,
    attribution: buildAttribution(
      sources,
      primaryIndex,
      results,
      required.length,
    ),
    callSites: reach.callSites ?? [],
  };
}
