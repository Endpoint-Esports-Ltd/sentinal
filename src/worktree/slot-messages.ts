/**
 * Worktree slot — every user-facing error and warning (see `slots.ts`).
 *
 * The wording here is load-bearing: each message names the operational
 * consequence and a remedy that actually fits the cause. Keep them together so
 * the remedies stay mutually consistent (e.g. never suggest `worktree_cleanup`
 * for a transient race).
 */

import { WorktreeError } from "./types.js";

/** Attempts for the allocate+insert transaction before surfacing SLOT_RACE. */
export const SLOT_INSERT_ATTEMPTS = 3;

/** The one place the SLOT_EXHAUSTED message is written. */
export function slotExhausted(maxActive: number): WorktreeError {
  return new WorktreeError(
    `No free worktree slot: all ${maxActive} slots (1-${maxActive}) are held by live worktrees ` +
      `(slot 0 is reserved for the main checkout). ` +
      `Merge or abandon a worktree, or run worktree_cleanup to reclaim orphans.`,
    "SLOT_EXHAUSTED",
  );
}

/**
 * The non-fatal counterpart of {@link slotExhausted}, for read paths that must
 * degrade instead of failing. Names the operational consequence, not just the
 * absence — silence is what lets a colliding runtime look like success.
 */
export function noFreeSlotWarning(
  projectPath: string,
  maxActive: number,
): string {
  return (
    `No free worktree slot for ${projectPath}: all ${maxActive} slots (1-${maxActive}) are held ` +
    `by live worktrees. Continuing WITHOUT a slot — this worktree's runtime is NOT namespaced and ` +
    `may collide with another worktree's ports or databases. Merge or abandon a worktree, or run ` +
    `worktree_cleanup, then re-run detection to have one assigned.`
  );
}

/** Lost every insert retry. Transient — surfaced as a typed `SLOT_RACE`. */
export function slotRaceError(key: string, lastRace: unknown): WorktreeError {
  return new WorktreeError(
    `Lost the race for a worktree slot ${SLOT_INSERT_ATTEMPTS} times — another Sentinal process ` +
      `is creating worktrees in ${key} concurrently. This is transient: retry. ` +
      `(underlying: ${lastRace instanceof Error ? lastRace.message : String(lastRace)})`,
    "SLOT_RACE",
  );
}

/** Lost every retry. Transient — say so, and do NOT suggest deleting worktrees. */
export function slotRaceWarning(projectPath: string, err: unknown): string {
  return (
    `Lost the race for a worktree slot ${SLOT_INSERT_ATTEMPTS} times in ${projectPath} — another ` +
    `Sentinal process is assigning slots concurrently. This worktree is continuing WITHOUT a slot, ` +
    `so its runtime is NOT namespaced and may collide with another worktree's ports or databases. ` +
    `This is transient: re-run detection to have a slot assigned. ` +
    `(underlying: ${describeError(err)})`
  );
}

/** Anything else that came out of the assign transaction. */
export function assignFailedWarning(projectPath: string, err: unknown): string {
  return (
    `Could not assign a worktree slot in ${projectPath}: ${describeError(err)}. Continuing WITHOUT ` +
    `a slot — this worktree's runtime is NOT namespaced and may collide with another worktree's ` +
    `ports or databases. Re-run detection once the underlying problem is fixed.`
  );
}

/** A D4 collision loser that could not be moved to a free slot. */
export function loserNotMovedWarning(
  worktreePath: string,
  held: number | null,
  key: string,
  reason: string | undefined,
): string {
  return (
    `${worktreePath} held slot ${held}, which an older LIVE worktree of ${key} ` +
    `also holds (revealed when their records were unified under one project key). It could ` +
    `not be moved: ${reason ?? "no free slot"}`
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The directory's own config was written against one slot and it has just been
 * handed a different one.
 *
 * ⛔ Reachable through a plain `worktree_detect`: `insertWithSlot` treats
 * `preferred` as best-effort and falls back to the lowest free slot when the
 * directory's own slot is taken. The seeded `.env` is then interpolated against
 * a slot that belongs to a DIFFERENT live worktree — the exact port/database
 * collision this phase exists to prevent. `skipExistingWarning` only says the
 * `.env` *may* be wrong; this says the two values are *known* to differ.
 */
export function warnIfSlotMismatch(
  warnings: string[] | undefined,
  worktreePath: string,
  onDiskSlot: number | null,
  assignedSlot: number | null | undefined,
): void {
  if (onDiskSlot === null || assignedSlot == null) return;
  if (onDiskSlot === assignedSlot) return;
  warnings?.push(slotMismatchWarning(worktreePath, onDiskSlot, assignedSlot));
}

function slotMismatchWarning(
  worktreePath: string,
  onDiskSlot: number,
  assignedSlot: number,
): string {
  return (
    `${worktreePath} has config written against slot ${onDiskSlot}, but slot ${onDiskSlot} is now ` +
    `held by another LIVE worktree, so this one was assigned slot ${assignedSlot}. Its existing ` +
    `.env therefore points at slot ${onDiskSlot}'s ports and databases — which belong to a ` +
    `different worktree, so concurrent work can corrupt shared state. Remedy: free slot ` +
    `${onDiskSlot} (merge/abandon its holder, or run worktree_cleanup) and re-run detection, or ` +
    `delete this worktree's .env and re-run detection to have it re-seeded for slot ${assignedSlot}.`
  );
}
