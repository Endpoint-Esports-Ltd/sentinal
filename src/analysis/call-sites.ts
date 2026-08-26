/**
 * Call-site rendering for `impact_analysis`.
 *
 * A reach number says *how much* is coupled; it never says *what*. "89 modules
 * reach this file" leaves a reader with no thread to pull, which is what made a
 * HIGH verdict unactionable. Call sites are the evidence for that number.
 *
 * Split out of `impact.ts` for the same reason `reach-sources.ts` was split out
 * of `reach.ts`: the section's two display caps need their rationale written
 * down beside them, and carrying that in `impact.ts` pushed it to 416 — past
 * Sentinal's own 400-line warn. `impact.ts` keeps the report structure; this
 * file keeps one section of it.
 */

import type { CallSite } from "./reach.js";

/**
 * Display caps for the call-site section.
 *
 * Two bounds rather than one, because a single global cap fails in both
 * directions. A global cap lets one hot file's 200 call sites starve every
 * other changed file out of the section entirely — losing exactly the "which
 * changed file is this evidence for" signal the grouping exists to give. A
 * per-file cap alone is unbounded in the number of files: a 40-file changeset
 * would still emit 200 lines, which is no more actionable than the bare count
 * this section exists to replace.
 *
 * `5` per file matches `inline()`'s cap in `reach-sources.ts`; five sites are
 * enough to characterise *how* a file is used without becoming a listing. `8`
 * files is the point past which the section stops being a thread to pull and
 * turns into a second copy of the Changed Files list above it. Both
 * truncations always state their omitted count — a silent cut would make the
 * section quietly misrepresent the evidence.
 */
export const CALL_SITES_PER_TARGET = 5;
export const CALL_SITE_TARGETS = 8;

/**
 * Render supplied call sites as evidence for the reach numbers above them.
 *
 * ⛔ Evidence only. Nothing here is read by `scoreRisk` — call sites arrive on
 * `resolveReach`'s result solely to be printed, so no arrangement of them can
 * move the verdict.
 *
 * Returns `[]` when none were supplied: an empty heading is noise, and the
 * built-in resolver never produces call sites, so the default report stays
 * byte-identical to what it was before this section existed.
 */
export function renderCallSites(callSites: CallSite[]): string[] {
  if (callSites.length === 0) return [];

  const byTarget = new Map<string, CallSite[]>();
  for (const cs of callSites) {
    const group = byTarget.get(cs.target);
    if (group) group.push(cs);
    else byTarget.set(cs.target, [cs]);
  }
  // Most evidence first — that is the file worth chasing. Path breaks ties so
  // the section is deterministic for a given input.
  const groups = [...byTarget.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  // Mirrors `reachAttribution`'s register in `impact.ts`: name where the data
  // came from, and say plainly that it did not feed the score.
  const lines = [
    "",
    "### Call Sites",
    `- Call sites: agent-supplied — ${plural(callSites.length, "call site")} across ${plural(groups.length, "changed file")}, evidence only (never scored)`,
  ];

  for (const [target, sites] of groups.slice(0, CALL_SITE_TARGETS)) {
    lines.push("", `**\`${target}\`** — ${plural(sites.length, "call site")}`);
    for (const cs of sites.slice(0, CALL_SITES_PER_TARGET)) {
      // `file:line` verbatim so an editor or terminal can jump straight to it.
      lines.push(
        `- \`${cs.file}:${cs.line}\` — \`${cs.caller}\` → \`${cs.callee}\``,
      );
    }
    const hidden = sites.length - CALL_SITES_PER_TARGET;
    if (hidden > 0) {
      lines.push(`- …and ${plural(hidden, "more call site")} for this file`);
    }
  }

  const spilled = groups.slice(CALL_SITE_TARGETS);
  if (spilled.length > 0) {
    const hidden = spilled.reduce((n, [, sites]) => n + sites.length, 0);
    lines.push(
      "",
      `- …and ${plural(hidden, "more call site")} across ${plural(spilled.length, "further changed file")}`,
    );
  }
  return lines;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
