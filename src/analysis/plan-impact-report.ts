/**
 * Rendering for `plan_impact` — bucketing of a plan's claimed files, and the
 * two report sections.
 *
 * Split out of `plan-impact.ts` (485 lines) purely for length, exactly as
 * `reach-sources.ts` was split out of `reach.ts`. `plan-impact.ts` keeps the
 * contract: the tool registration and {@link WaveOverlap} detection, which is
 * the deterministic half and the thing worth reading first.
 *
 * ⛔ **The epistemic split D4 mandates is enforced here, in the prose.**
 * {@link buildOverlapSection} states a fact about the plan text and never
 * claims harm; {@link buildReachSection} opens with {@link REACH_PREAMBLE},
 * which names the prediction assumption INLINE — not merely in docs — and says
 * outright that it does not replace `impact_analysis` on a real diff. The two
 * sections must not be made to read alike.
 *
 * This module imports only the `WaveOverlap` *type* from `plan-impact.ts`, so
 * there is no runtime cycle between them.
 */

import { relative } from "node:path";
import type { RiskLevel } from "./helpers.js";
import type { PlanTaskFiles } from "./plan-files.js";
import { isHighReach, isMediumReach } from "./reach.js";
import type { WaveOverlap } from "./plan-impact.js";

// --- Claimed files ---

export interface ClaimedFile {
  path: string;
  exists: boolean;
  /** Ids of every task claiming it, document order. */
  tasks: string[];
}

/** Distinct paths across the whole plan, each carrying its claimants. */
export function collectClaimed(tasks: PlanTaskFiles[]): ClaimedFile[] {
  const map = new Map<string, ClaimedFile>();
  for (const task of tasks) {
    for (const file of task.files) {
      let entry = map.get(file.path);
      if (!entry) {
        entry = { path: file.path, exists: file.exists, tasks: [] };
        map.set(file.path, entry);
      }
      // One task's `Create:` and another's `Modify:` describe the same path;
      // if any claimant found it on disk, it is on disk.
      if (file.exists) entry.exists = true;
      if (!entry.tasks.includes(task.id)) entry.tasks.push(task.id);
    }
  }
  return [...map.values()];
}

// --- Output helpers ---

const CAP = 12;

function listPaths(files: ClaimedFile[]): string[] {
  const shown = files
    .slice(0, CAP)
    .map((f) => `- \`${f.path}\` (Task ${f.tasks.join(", ")})`);
  if (files.length > CAP) shown.push(`- …and ${files.length - CAP} more`);
  return shown;
}

/**
 * Re-head the shared rejection block.
 *
 * `rejectReach` opens with `## Impact Analysis — supplied \`reach\` rejected`,
 * correct for the tool it was written for and wrong here. Everything below that
 * heading — which names the missing paths and is the part that actually repairs
 * the caller's map — is tool-agnostic and reused verbatim, so only the first
 * line is dropped. Keyed on the `## ` prefix rather than the exact string, so
 * edits to the body cannot silently defeat it.
 */
export function stripRejectionHeading(error: string): string {
  const lines = error.split("\n");
  if (lines[0]?.startsWith("## ")) lines.shift();
  while (lines[0] === "") lines.shift();
  return lines.join("\n");
}

export function planLabel(project: string, planPath: string): string {
  const rel = relative(project, planPath);
  return rel && !rel.startsWith("..") ? rel : planPath;
}

// --- Overlap section ---

export function buildOverlapSection(
  tasks: PlanTaskFiles[],
  overlaps: WaveOverlap[],
): string[] {
  const waves = [
    ...new Set(tasks.map((t) => t.wave).filter((w): w is number => w !== null)),
  ].sort((a, b) => a - b);
  const unwaved = tasks.filter((t) => t.wave === null);

  const lines = [
    "### Wave Overlap — deterministic",
    "",
    "Checks the plan against its own rule: *tasks in the same wave MUST NOT modify the same files*. This is a fact about the **plan text** — it holds or fails regardless of what the implementation later touches — so it needs no code-graph tool and no injected `reach`.",
    "",
    "⛔ On OpenCode, the tasks of a wave run in ONE shared working directory, so a same-wave overlap corrupts work rather than merely racing.",
    "",
  ];

  if (overlaps.length === 0) {
    lines.push(
      `**No same-wave overlaps** across ${waves.length} wave${waves.length === 1 ? "" : "s"} (${waves.length > 0 ? waves.join(", ") : "none assigned"}).`,
    );
  } else {
    lines.push(
      `**${overlaps.length} same-wave overlap${overlaps.length === 1 ? "" : "s"}:**`,
      "",
    );
    for (const o of overlaps) {
      const owners = o.tasks
        .map((t) => `Task ${t.id}${t.title ? ` (${t.title})` : ""}`)
        .join(", ");
      lines.push(`- **Wave ${o.wave}** — \`${o.path}\` claimed by ${owners}`);
    }
    lines.push(
      "",
      // ⛔ Pre-Mortem 2 fired: 3 of 89 VERIFIED plans in this repo carry one.
      // None is a parser artifact, but all three shipped, and one resolved the
      // conflict in wave prose the `**Wave:**` field cannot express. So the
      // wording claims a plan-text fact and never claims harm.
      "**Advisory, not a block.** Resolve by re-waving one task, splitting the file, or declaring the wave **sequential** — a wave executed sequentially satisfies the rule in a way the per-task `**Wave:**` field cannot express, and this check cannot see that. Measured on this repo, 3 of 89 VERIFIED plans carry a flagged overlap, so a flag is a statement about the plan text, not evidence of harm.",
    );
  }

  if (unwaved.length > 0) {
    lines.push(
      "",
      `⚠️ ${unwaved.length} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} declare no \`**Wave:**\` and **cannot be assessed** — they are **not assumed** to be wave 1: ${unwaved
        .slice(0, CAP)
        .map((t) => `Task ${t.id}`)
        .join(", ")}${unwaved.length > CAP ? ", …" : ""}.`,
    );
  }
  return lines;
}

// --- Reach section ---

export interface ScoredFile extends ClaimedFile {
  reach: number;
  /** False when the built-in graph has no node for it. */
  inGraph: boolean;
}

export const REACH_PREAMBLE = [
  "### Prospective Reach — advisory",
  "",
  "_Assumption: a plan's `Files:` list is a **prediction**. Implementation routinely touches files a plan never names, so this measures the code the plan **points at**, not the change that will occur. It is a hint; it **does not replace** running `impact_analysis` on the real diff, and it is not a verification step._",
  "",
];

export function buildReachSection(
  scored: ScoredFile[],
  buckets: { missing: ClaimedFile[]; nonCode: ClaimedFile[]; total: number },
  moduleCount: number,
  attribution: string[],
): string[] {
  const { missing, nonCode, total } = buckets;
  const lines = [...REACH_PREAMBLE];
  const top = Math.max(0, ...scored.map((f) => f.reach));
  const verdict: RiskLevel = isHighReach(top, moduleCount)
    ? "HIGH"
    : isMediumReach(top, moduleCount)
      ? "MEDIUM"
      : "LOW";

  lines.push(
    `- Reach verdict: **${verdict}** — highest prospective reach ${top} of ${moduleCount} module${moduleCount === 1 ? "" : "s"}`,
    `- Scored: ${scored.length} of ${total} claimed file${total === 1 ? "" : "s"} ${scored.length === 1 ? "exists" : "exist"} on disk`,
  );
  // The three buckets must sum to `total`, or a reader silently loses files.
  if (nonCode.length > 0) {
    lines.push(
      `- Unscored: ${nonCode.length} ${nonCode.length === 1 ? "exists" : "exist"} but ${nonCode.length === 1 ? "is" : "are"} not \`.ts\`/\`.tsx\`/\`.js\` — reach is not defined for ${nonCode.length === 1 ? "it" : "them"}`,
    );
  }
  if (missing.length > 0) {
    lines.push(
      `- Unscored: ${missing.length} ${missing.length === 1 ? "does" : "do"} not exist on disk (below)`,
    );
  }

  const ranked = [...scored]
    .filter((f) => f.reach > 0)
    .sort((a, b) => b.reach - a.reach);
  if (ranked.length > 0) {
    lines.push("");
    for (const f of ranked.slice(0, CAP)) {
      const label = isHighReach(f.reach, moduleCount)
        ? "HIGH REACH: "
        : isMediumReach(f.reach, moduleCount)
          ? "reach: "
          : "";
      const share = moduleCount
        ? ` — ${Math.round((f.reach / moduleCount) * 100)}% of ${moduleCount}`
        : "";
      lines.push(
        `- **${label}\`${f.path}\` is reached by ${f.reach} module${f.reach === 1 ? "" : "s"}** (transitive)${share}`,
      );
    }
    if (ranked.length > CAP) {
      lines.push(`- …and ${ranked.length - CAP} more with non-zero reach`);
    }
  }

  const offGraph = scored.filter((f) => !f.inGraph);
  if (offGraph.length > 0) {
    lines.push(
      "",
      `_${offGraph.length} scored file${offGraph.length === 1 ? " lies" : "s lie"} outside the scanned import tree (\`src/\` when it exists), so the built-in resolver reports 0 for ${offGraph.length === 1 ? "it" : "them"} — absence of reach there is absence of evidence, not evidence of absence._`,
    );
  }

  if (missing.length > 0) {
    lines.push(
      "",
      `**Unscored — ${missing.length} of ${total} claimed file${total === 1 ? "" : "s"} ${missing.length === 1 ? "does" : "do"} not exist on disk.** Reach is undefined for a file that is not yet in the import graph: \`countTransitiveImporters\` has no node for it, so it would score 0 and drag the verdict to LOW. These are excluded from the verdict rather than counted as zero. The gate is **on-disk existence, not the \`Create:\` verb** — the inline \`**Files:**\` form used throughout this repo's plans states no verb at all.`,
      "",
      ...listPaths(missing),
    );
  }

  lines.push(...attribution);
  return lines;
}
