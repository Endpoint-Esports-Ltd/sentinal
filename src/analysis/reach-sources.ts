/**
 * Per-source normalisation, validation, attribution and rejection prose for
 * agent-supplied reach.
 *
 * Split out of `reach.ts` when the single-source shape became a list: the
 * validation and message-building alone would have pushed `reach.ts` past
 * Sentinal's own 400-line warn. `reach.ts` keeps the contract (schemas,
 * thresholds, `resolveReach`); this file keeps the bookkeeping.
 *
 * ⛔ This file imports NOTHING from `reach.ts`. `AgentReachSchema` calls
 * `normalizeReachSources` from inside its own refinement, so a type import of
 * `AgentReach` here would make the schema reference its own inferred type
 * (`TS2502`/`TS7022`). The input is therefore described structurally by
 * {@link ReachInput}; `AgentReach` stays assignable to it, and TypeScript
 * checks that at every call site, so the two cannot drift apart silently.
 */

import { z } from "zod";

/** One source's file map. Shared by both accepted shapes. */
export const filesField = z
  .record(z.string(), z.number().int().nonnegative())
  .describe(
    "Repo-relative path -> modules transitively reaching it, exactly as `git diff --name-only` prints the path. Must cover EVERY changed .ts/.tsx/.js file for this source, and every value must be <= this source's own moduleCount (a larger value proves the two came from different metrics).",
  );

/**
 * One reach source: per-file counts plus the universe they were measured in.
 *
 * The universe travels **with** the source rather than sitting at report level,
 * so a module-level and a symbol-level tool can both be supplied without either
 * one's numbers being divided by the other's scalar.
 */
export const ReachSourceSchema = z.object({
  source: z
    .string()
    .optional()
    .describe(
      "Name of the tool that produced these numbers, e.g. '<server> <tool>'. Reported verbatim; used to name this source if it is rejected.",
    ),
  primary: z
    .boolean()
    .optional()
    .describe(
      "Mark at most ONE source `true` to make it the scored source. If none is marked the FIRST entry scores. Every other source is accepted for reporting only and is rendered explicitly as unscored.",
    ),
  moduleCount: z
    .number()
    .int()
    .positive()
    .describe(
      "Total modules in this source's OWN universe. Never shared with, compared against, or converted into another source's universe.",
    ),
  files: filesField,
});

/** A single call site: evidence for a reach number, never an input to one. */
export const CallSiteSchema = z.object({
  file: z
    .string()
    .describe(
      "Repo-relative path of the file containing the call, exactly as `git diff --name-only` prints it.",
    ),
  line: z.number().int().positive().describe("1-based line of the call site."),
  caller: z.string().describe("Symbol the call is made from."),
  callee: z.string().describe("Symbol being called."),
  target: z
    .string()
    .describe(
      "Repo-relative path of the changed file this call site is evidence for.",
    ),
});

export type CallSite = z.infer<typeof CallSiteSchema>;

/**
 * The structural view of an agent-supplied `reach` argument.
 *
 * Every field is optional because this type is also applied to values that have
 * not yet passed validation — including inside `AgentReachSchema`'s own
 * refinements, where zod has not finished narrowing anything.
 */
export interface ReachInput {
  sources?: Array<{
    source?: string;
    primary?: boolean;
    moduleCount?: number;
    files?: Record<string, number>;
  }>;
  moduleCount?: number;
  files?: Record<string, number>;
  source?: string;
}

/** A reach source after normalisation — exactly one universe, one file map. */
export interface NormalizedSource {
  /** Agent-supplied name, or `undefined` when none was given. */
  name?: string;
  /** 1-based position in the supplied list; labels unnamed sources. */
  position: number;
  /** True only for the source that scores. */
  primary: boolean;
  /** This source's OWN universe size. Never shared with another source. */
  moduleCount: number | undefined;
  files: Record<string, number>;
}

export type SourceValidation =
  | {
      ok: true;
      moduleCount: number;
      overrides: Map<string, number>;
    }
  | {
      ok: false;
      /** Full markdown detail, ready for `rejectReach`. */
      detail: string[];
      /** One-line reason, for the unscored-source attribution list. */
      summary: string;
    };

/**
 * Collapse either accepted shape into a list of sources.
 *
 * ⛔ D2 — the single-object form (`{moduleCount, files, source}`) is what the
 * currently-shipped `mcp-servers.md` documents, so it stays valid and is
 * normalised here to a one-element list. Every layer above this function sees
 * only the list, which is why back-compat costs nothing downstream.
 */
export function normalizeReachSources(reach: ReachInput): NormalizedSource[] {
  const raw = reach.sources ?? [
    {
      source: reach.source,
      primary: true,
      moduleCount: reach.moduleCount,
      files: reach.files,
    },
  ];
  return raw.map((s, i) => ({
    name: s?.source,
    position: i + 1,
    primary: s?.primary === true,
    moduleCount: s?.moduleCount,
    files: s?.files ?? {},
  }));
}

/**
 * The one source that scores: the one marked `primary`, else the first.
 *
 * "Else the first" is a deliberate, order-dependent default rather than an
 * error, because the single-object form has no way to mark anything primary.
 * The schema rejects *more* than one primary, so the choice is never ambiguous
 * for a caller who marked anything at all.
 */
export function selectPrimaryIndex(sources: NormalizedSource[]): number {
  const marked = sources.findIndex((s) => s.primary);
  return marked === -1 ? 0 : marked;
}

/** How a source is named in prose: its own name, or its position. */
export function sourceLabel(src: NormalizedSource): string {
  return src.name ?? `source ${src.position}`;
}

/**
 * Validate one source against the changeset, in isolation.
 *
 * Isolation is the point: a reporting-only source that fails coverage must be
 * droppable by name without touching the source that actually scores.
 *
 * Re-checks invariants `AgentReachSchema` already enforces. That is deliberate,
 * not redundant: `resolveReach` is reachable from any in-process caller (and
 * from the tests) without passing through MCP's zod validation, and an
 * unchecked bad value here mis-scores the report rather than erroring.
 */
export function validateSource(
  src: NormalizedSource,
  required: string[],
): SourceValidation {
  const { moduleCount, files } = src;
  if (
    typeof moduleCount !== "number" ||
    !Number.isFinite(moduleCount) ||
    moduleCount <= 0
  ) {
    return {
      ok: false,
      detail: [
        `**Invalid \`moduleCount\`:** \`${moduleCount}\` — must be a finite number greater than 0.`,
      ],
      summary: `invalid \`moduleCount\` (\`${moduleCount}\`)`,
    };
  }

  const missing = required.filter((p) => !Object.hasOwn(files, p));
  const invalid = Object.entries(files).filter(
    ([, v]) => !Number.isFinite(v) || v < 0 || v > moduleCount,
  );
  if (missing.length > 0 || invalid.length > 0) {
    return {
      ok: false,
      detail: buildRejectionDetail(
        src,
        missing,
        invalid,
        required,
        files,
        moduleCount,
      ),
      summary: buildFailureSummary(missing, invalid, required),
    };
  }

  return {
    ok: true,
    moduleCount,
    overrides: new Map(required.map((p) => [p, files[p]])),
  };
}

/**
 * Report lines naming what scored, what did not, and why.
 *
 * ⛔ D1 — every non-primary source is rendered EXPLICITLY as unscored. A reader
 * who sees two sources listed must not be able to conclude that both fed the
 * verdict, because the two are measured in universes that do not convert into
 * one another.
 */
export function buildAttribution(
  sources: NormalizedSource[],
  primaryIndex: number,
  results: SourceValidation[],
  requiredCount: number,
): string[] {
  const primary = sources[primaryIndex];
  const files = `changed TS file${requiredCount === 1 ? "" : "s"}`;
  const multi = sources.length > 1;
  const lines = [
    `- Reach: agent-supplied — ${requiredCount} of ${requiredCount} ${files} covered, universe ${primary.moduleCount} modules`,
  ];
  if (primary.name) {
    lines.push(
      `- Reach source: ${primary.name}${multi ? " (primary — the only source scored)" : ""}`,
    );
  }
  if (!multi) return lines;

  for (const [i, src] of sources.entries()) {
    if (i === primaryIndex) continue;
    const result = results[i];
    lines.push(
      result.ok
        ? `- Additional source (unscored, reporting only): ${sourceLabel(src)} — universe ${src.moduleCount} modules`
        : `- Additional source (unscored, rejected): ${sourceLabel(src)} — ${result.summary}`,
    );
  }
  lines.push(
    "- Only the primary source is scored: shares measured in different universes are not commensurable, so the verdict must not depend on which servers happen to be installed.",
  );
  return lines;
}

function buildFailureSummary(
  missing: string[],
  invalid: [string, number][],
  required: string[],
): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `${required.length - missing.length} of ${required.length} changed TS files covered; missing ${inline(missing)}`,
    );
  }
  if (invalid.length > 0) {
    parts.push(`out-of-range value for ${inline(invalid.map(([k]) => k))}`);
  }
  return parts.join("; ");
}

/** Up to `cap` backticked paths, with an overflow count. */
function inline(paths: string[], cap = 5): string {
  const shown = paths.slice(0, cap).map((p) => `\`${p}\``);
  if (paths.length > cap) shown.push(`…and ${paths.length - cap} more`);
  return shown.join(", ");
}

function buildRejectionDetail(
  src: NormalizedSource,
  missing: string[],
  invalid: [string, number][],
  required: string[],
  files: Record<string, number>,
  moduleCount: number,
): string[] {
  // Only name the source when the agent named it. An unnamed single-object
  // `reach` has nothing useful to be called, and "source 1" would be noise.
  const of = src.name ? ` in source \`${src.name}\`` : "";
  const detail: string[] = [];
  if (missing.length > 0) {
    detail.push(
      `**Missing from \`files\`${of}** — ${required.length - missing.length} of ${required.length} changed TS files covered:`,
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
      `**Invalid values in \`files\`${of}** (each must be a finite integer between 0 and that source's \`moduleCount\`):`,
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

/**
 * The whole-call rejection.
 *
 * Reached only when the **primary** source is unusable — a non-primary failure
 * is reported in the attribution and never blocks the analysis. The prose
 * deliberately says nothing about the other sources: they were not the cause,
 * and blaming them would send the agent to fix the wrong map.
 */
export function rejectReach(detail: string[]): string {
  return [
    "## Impact Analysis — supplied `reach` rejected",
    "",
    "Nothing was scored. Applying this map would have measured some files against your module universe and the rest against Sentinal's built-in one, silently mis-scoring every line of the report.",
    "",
    ...detail,
    "",
    "`files` keys must be **repo-relative** paths exactly as `git diff --name-only` prints them (`src/a.ts`, not `/abs/path/src/a.ts`), must cover every changed `.ts`/`.tsx`/`.js` file, and every value must be measured against the same `moduleCount`.",
    "",
    "Fix the map and retry, or omit `reach` entirely to use Sentinal's built-in import graph.",
  ].join("\n");
}
