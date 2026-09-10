/**
 * Worktree Slot Allocation
 *
 * Every worktree gets an integer **slot**, unique among the *live* worktrees of
 * one project (D2). Sentinal makes no claim about what a project does with the
 * number — the only guarantee is: unique while live, reused only after release.
 *
 * ## Two rules that are easy to get wrong
 *
 * **⛔ Slot 0 is reserved for the developer's main checkout (D7).** Allocation
 * runs over the closed range `[1, maxActive]`. The main checkout is never a
 * worktree record, so without the reservation the first worktree would receive
 * the number the developer's own default stack is already using — exactly the
 * collision slots exist to prevent. Slot 0 is *not* counted against `maxActive`,
 * so capacity is unchanged (default 5 → slots 1-5).
 *
 * **⛔ There is no `releaseSlot()`, deliberately.** Release is *emergent* from
 * the `idx_wt_slot_live` partial unique index: the moment a row leaves
 * `('active','ready-to-merge')` — or is deleted — it drops out of the index and
 * `listLiveSlots` stops reporting it. Writing `SET slot = NULL` on release would
 * be actively harmful: it destroys the record of which slot a merged/abandoned
 * worktree held, which is what lets `resolveWithReconcile` hand a recovered
 * directory back the slot its own on-disk config was written against.
 *
 * Allocator state lives in SQLite only — sidecar handlers construct a fresh
 * `WorktreeManager` per request, so instance memory would be worthless.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeStore } from "./store.js";
import { WorktreeError, type Worktree } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

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

/** Attempts for the allocate+insert transaction before surfacing SLOT_RACE. */
const SLOT_INSERT_ATTEMPTS = 3;

// ─── Pure allocation ────────────────────────────────────────────────────────

/**
 * Lowest slot in `[1, maxActive]` not present in `taken`, or `null` if the pool
 * is exhausted. Values outside the range (including 0) are simply ignored.
 */
export function findFreeSlot(
  taken: Iterable<number>,
  maxActive: number,
): number | null {
  const held = new Set(taken);
  for (let s = FIRST_ALLOCATABLE_SLOT; s <= maxActive; s++) {
    if (!held.has(s)) return s;
  }
  return null;
}

/** True when `slot` is a slot the allocator is allowed to hand out. */
export function isAllocatableSlot(
  slot: number | null | undefined,
  maxActive: number,
): slot is number {
  return (
    typeof slot === "number" &&
    Number.isInteger(slot) &&
    slot >= FIRST_ALLOCATABLE_SLOT &&
    slot <= maxActive
  );
}

/**
 * Allocate the lowest free slot for `projectPath`.
 *
 * @throws {WorktreeError} `SLOT_EXHAUSTED` when the pool is provably full.
 */
export function allocateSlot(
  store: WorktreeStore,
  projectPath: string,
  maxActive: number,
): number {
  const slot = tryAllocateSlot(store, projectPath, maxActive);
  if (slot === null) throw slotExhausted(maxActive);
  return slot;
}

/**
 * Non-throwing variant. Use this on **read-shaped** paths (`worktree_detect` →
 * `resolveWithReconcile`): a "where is my worktree" call must never hard-fail
 * because the slot pool happens to be full.
 */
export function tryAllocateSlot(
  store: WorktreeStore,
  projectPath: string,
  maxActive: number,
): number | null {
  return findFreeSlot(store.listLiveSlots(projectPath), maxActive);
}

/** The one place the SLOT_EXHAUSTED message is written. */
function slotExhausted(maxActive: number): WorktreeError {
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

// ─── Allocate + insert, atomically ──────────────────────────────────────────

export interface InsertWithSlotOptions {
  /**
   * Slot to reuse if it is still free — the recovery path. Ignored when out of
   * range, reserved, or taken.
   */
  preferred?: number | null;
  /**
   * What to do when the pool is full.
   * - `"throw"` (default) — `create()`: a typed `SLOT_EXHAUSTED` is correct.
   * - `"null"` — reconcile/detect: insert with `slot = null` + a warning.
   */
  onExhausted?: "throw" | "null";
  /** Collector for non-fatal warnings. */
  warnings?: string[];
  /** Testing hook: insert unslotted regardless of pool state. */
  forceNull?: boolean;
}

/**
 * Allocate a slot and insert the worktree row **in one `BEGIN IMMEDIATE`
 * transaction**, retrying a lost race.
 *
 * ⚠️ `listLiveSlots()` (SELECT) and `store.insert()` (INSERT) are separate
 * statements, and the CLI, MCP server and sidecar all open the same DB file.
 * Two processes can read the same lowest-free slot; IMMEDIATE takes the write
 * lock up front, and the partial unique index is the backstop.
 *
 * ⛔ A `SQLITE_CONSTRAINT` on the slot index is **NOT** mapped to
 * `SLOT_EXHAUSTED`. It is a lost race — transient — and `SLOT_EXHAUSTED`'s
 * remedy (`worktree_cleanup`) would have the user delete healthy worktrees to
 * fix a condition that resolves itself. It surfaces as `SLOT_RACE` instead.
 */
export function insertWithSlot(
  store: WorktreeStore,
  wt: Omit<Worktree, "mergedAt" | "mergeCommit" | "slot">,
  maxActive: number,
  opts: InsertWithSlotOptions = {},
): Worktree {
  const { preferred, onExhausted = "throw", warnings, forceNull } = opts;

  if (forceNull) return store.insert({ ...wt, slot: null });

  let lastRace: unknown;
  for (let attempt = 0; attempt < SLOT_INSERT_ATTEMPTS; attempt++) {
    let exhausted = false;
    try {
      const inserted = store.runImmediate(() => {
        const taken = store.listLiveSlots(wt.projectPath);
        const slot =
          isAllocatableSlot(preferred, maxActive) && !taken.includes(preferred)
            ? preferred
            : findFreeSlot(taken, maxActive);

        if (slot === null) {
          if (onExhausted === "throw") throw slotExhausted(maxActive);
          exhausted = true;
          return store.insert({ ...wt, slot: null });
        }
        return store.insert({ ...wt, slot });
      });

      if (exhausted) {
        warnings?.push(noFreeSlotWarning(wt.projectPath, maxActive));
      }
      return inserted;
    } catch (err) {
      if (!isSlotRace(err)) throw err;
      lastRace = err;
    }
  }

  throw new WorktreeError(
    `Lost the race for a worktree slot ${SLOT_INSERT_ATTEMPTS} times — another Sentinal process ` +
      `is creating worktrees in ${wt.projectPath} concurrently. This is transient: retry. ` +
      `(underlying: ${lastRace instanceof Error ? lastRace.message : String(lastRace)})`,
    "SLOT_RACE",
  );
}

// ─── Allocate + assign to an EXISTING row, atomically ───────────────────────

/** Outcome of {@link tryAssignFreeSlot}. `warning` is set iff `slot` is null. */
export interface AssignSlotResult {
  slot: number | null;
  warning?: string;
}

/**
 * Assign a free slot to a row that already exists (lazy allocation of a pre-V12
 * `slot = NULL` row), in one `BEGIN IMMEDIATE` transaction, retrying a lost
 * race — the same envelope {@link insertWithSlot} uses for the insert path.
 *
 * ⛔ **This function NEVER throws.** Its only caller is `ensureSlot`, which sits
 * on the `worktree_detect` READ path. `listLiveSlots` (SELECT) + `assignSlot`
 * (UPDATE) is the identical read-then-write race the insert path guards, and
 * losing it raises `SQLITE_CONSTRAINT_UNIQUE` on `idx_wt_slot_live` — turning
 * "where is my worktree?" into an error. Every failure degrades to
 * `slot = null` plus a warning naming the cause.
 */
export function tryAssignFreeSlot(
  store: WorktreeStore,
  id: string,
  projectPath: string,
  maxActive: number,
): AssignSlotResult {
  let lastRace: unknown;

  for (let attempt = 0; attempt < SLOT_INSERT_ATTEMPTS; attempt++) {
    try {
      const slot = store.runImmediate(() => {
        const free = findFreeSlot(store.listLiveSlots(projectPath), maxActive);
        if (free === null) return null;
        store.assignSlot(id, free);
        return free;
      });

      return slot === null
        ? { slot: null, warning: noFreeSlotWarning(projectPath, maxActive) }
        : { slot };
    } catch (err) {
      // A non-race failure (I/O, corruption) is not retryable, but it is also
      // not a reason to fail a read — report it and continue unslotted.
      if (!isSlotRace(err)) {
        return { slot: null, warning: assignFailedWarning(projectPath, err) };
      }
      lastRace = err;
    }
  }

  return { slot: null, warning: slotRaceWarning(projectPath, lastRace) };
}

/** Lost every retry. Transient — say so, and do NOT suggest deleting worktrees. */
function slotRaceWarning(projectPath: string, err: unknown): string {
  return (
    `Lost the race for a worktree slot ${SLOT_INSERT_ATTEMPTS} times in ${projectPath} — another ` +
    `Sentinal process is assigning slots concurrently. This worktree is continuing WITHOUT a slot, ` +
    `so its runtime is NOT namespaced and may collide with another worktree's ports or databases. ` +
    `This is transient: re-run detection to have a slot assigned. ` +
    `(underlying: ${describeError(err)})`
  );
}

/** Anything else that came out of the assign transaction. */
function assignFailedWarning(projectPath: string, err: unknown): string {
  return (
    `Could not assign a worktree slot in ${projectPath}: ${describeError(err)}. Continuing WITHOUT ` +
    `a slot — this worktree's runtime is NOT namespaced and may collide with another worktree's ` +
    `ports or databases. Re-run detection once the underlying problem is fixed.`
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `err` is a unique-constraint violation on the slot index. */
function isSlotRace(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== "SQLITE_CONSTRAINT_UNIQUE") {
    return false;
  }
  // Guard against unrelated unique violations. (The `id` primary key reports
  // SQLITE_CONSTRAINT_PRIMARYKEY, but be explicit rather than rely on that.)
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.includes("slot");
}

/**
 * The directory's own config was written against one slot and it has just been
 * handed a different one.
 *
 * ⛔ Reachable through a plain `worktree_detect`: {@link insertWithSlot} treats
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
 * {@link tryAssignFreeSlot}) — and telling the owner of a five-minute-old
 * worktree it predates a migration is a false cause with no remedy attached.
 * The accompanying warning carries the specifics; this points at it.
 */
export function formatSlot(slot: number | null | undefined): string {
  return typeof slot === "number"
    ? `${slot} (slot 0 is the main checkout)`
    : "not assigned (pre-V12 record, or no free slot — see warnings)";
}
