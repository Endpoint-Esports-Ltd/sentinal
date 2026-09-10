/**
 * Parse-hygiene helpers for the spec plan parser (M5).
 *
 * Extracted from `parser.ts` to keep it under the 400-line warn threshold.
 */

import type { SpecTask } from "./types.js";

/**
 * A code-fence delimiter, ignoring indentation.
 *
 * Supported dialect (deliberately identical to `src/analysis/plan-files.ts`
 * so a future unification is a pure move):
 *   - ``` and ~~~ openers/closers, with or without an info string (```ts).
 *   - Any indentation (CommonMark caps fences at 3 leading spaces, but plans
 *     nest example fences inside list items at arbitrary depth).
 *
 * NOT supported (same as plan-files.ts — plans in this corpus never need it):
 *   - Fence-type matching: a ``` opener can be "closed" by ~~~.
 *   - Fence-length matching: ````` inside a ``` block toggles the state.
 */
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Single-pass fence tracking: returns one boolean per line, `true` when the
 * line is a fence delimiter or inside a fenced block. An unclosed trailing
 * fence marks everything after it as fenced.
 */
export function markFencedLines(lines: string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      fenced[i] = true; // Delimiter lines are never content.
      continue;
    }
    fenced[i] = inFence;
  }
  return fenced;
}

/**
 * Deduplicate tasks sharing a position — LAST occurrence wins.
 *
 * Rationale: duplicate positions in real plans come from edits appended lower
 * in the file (a task re-stated in Progress Tracking, or a revised heading
 * added below the original), so the later occurrence is the fresher intent.
 * First-wins was the alternative and would instead preserve the original
 * authoring, but it lets a stale `[x]` mask a task that was re-opened below.
 *
 * Output order preserves the FIRST occurrence's document position, so a
 * deduped list still reads in plan order.
 */
export function dedupeTasksByPosition(tasks: SpecTask[]): SpecTask[] {
  const byPosition = new Map<number, SpecTask>();
  for (const task of tasks) {
    byPosition.set(task.position, task);
  }
  return Array.from(byPosition.values());
}
