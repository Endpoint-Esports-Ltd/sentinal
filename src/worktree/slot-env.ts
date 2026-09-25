/**
 * Worktree slot — constants and the on-disk env file (see `slots.ts`).
 *
 * ⛔ This module is a LEAF: it imports nothing from `src/worktree/`. It exists so
 * that `worktree-config.ts` (which needs the constants at evaluation time) and
 * `slot-pool.ts` (which needs `seedNonFatally` from `worktree-config.ts`) no
 * longer form a cycle. Before the split both halves lived in `slots.ts`, and the
 * cycle had to be broken with a lazy `require` to avoid a TDZ `ReferenceError`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Reserved for the developer's main checkout. Never allocated (D7). */
export const MAIN_CHECKOUT_SLOT = 0;

/** Allocation starts here, because {@link MAIN_CHECKOUT_SLOT} is reserved. */
export const FIRST_ALLOCATABLE_SLOT = 1;

/**
 * Where the sourceable slot env file lives *inside* a worktree.
 *
 * Under `.sentinal/` rather than at the worktree root on purpose: a
 * directory-scoped self-ignoring `.sentinal/.gitignore` works even when the
 * project's root `.gitignore` is tracked (see the Task 1 spike findings).
 */
export const SLOT_ENV_RELATIVE_PATH = ".sentinal/worktree.env";

/** The single variable Sentinal interpolates and exports (D6). */
export const SLOT_ENV_VAR = "SENTINAL_WORKTREE_SLOT";

// ─── Recovery from the worktree's own on-disk config ────────────────────────

/**
 * Read the slot recorded in a worktree's own env file.
 *
 * This is the **authoritative** recovery source when re-registering a worktree
 * that lost its DB row: that value is what the directory's seeded `.env` was
 * written against, so any other choice hands the directory a slot contradicting
 * its own on-disk config.
 *
 * Returns `null` for a missing/unreadable/unparseable file, and — deliberately —
 * for slot 0, which is reserved and must never be adopted from disk.
 */
export function readSlotFromWorktree(worktreePath: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(worktreePath, SLOT_ENV_RELATIVE_PATH), "utf-8");
  } catch {
    return null;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== SLOT_ENV_VAR) continue;

    const raw = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return value >= FIRST_ALLOCATABLE_SLOT ? value : null;
  }
  return null;
}

/**
 * Render a slot for human/LLM output, stating the slot-0 convention.
 *
 * ⛔ The unassigned wording must NOT blame "pre-V12" alone. `slot = null` has a
 * second origin this phase introduces deliberately — an exhausted pool or a
 * lost race on the reconcile/detect path (`onExhausted: "null"`,
 * `tryAssignFreeSlot`) — and telling the owner of a five-minute-old
 * worktree it predates a migration is a false cause with no remedy attached.
 * The accompanying warning carries the specifics; this points at it.
 */
export function formatSlot(slot: number | null | undefined): string {
  return typeof slot === "number"
    ? `${slot} (slot 0 is the main checkout)`
    : "not assigned (pre-V12 record, or no free slot — see warnings)";
}
