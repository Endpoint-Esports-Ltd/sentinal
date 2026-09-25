/**
 * Worktree slot — allocation and the atomic insert/assign transactions.
 * The rules governing the pool are documented in `slots.ts`, the public face.
 *
 * ⛔ {@link reslotLosers} and {@link tryAssignFreeSlot} call each other and MUST
 * stay in this one module — splitting them re-creates the TDZ hazard that the
 * old lazy `require` existed to paper over.
 */

import { existsSync } from "node:fs";
import {
  assignFailedWarning,
  loserNotMovedWarning,
  noFreeSlotWarning,
  SLOT_INSERT_ATTEMPTS,
  slotExhausted,
  slotRaceError,
  slotRaceWarning,
  warnIfSlotMismatch,
} from "./slot-messages.js";
import { FIRST_ALLOCATABLE_SLOT, readSlotFromWorktree } from "./slot-env.js";
import { scopeFor, type SlotScope, type WorktreeLister } from "./slot-scope.js";
import type { WorktreeStore } from "./store.js";
import type { Worktree } from "./types.js";
import { seedNonFatally } from "./worktree-config.js";

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
  /**
   * Pre-resolved repo scope. Omit to resolve it from `wt.projectPath` (one
   * git call, before the transaction); pass `null` to force the literal key.
   */
  scope?: SlotScope | null;
  /** Injectable lister for scope resolution (tests). */
  listWorktrees?: WorktreeLister;
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

  // ⛔ git runs HERE, before the write lock — never inside runImmediate.
  const scope = scopeFor(wt.projectPath, opts);
  const key = scope?.key ?? wt.projectPath;

  let lastRace: unknown;
  for (let attempt = 0; attempt < SLOT_INSERT_ATTEMPTS; attempt++) {
    let exhausted = false;
    let losers: Worktree[] = [];
    try {
      const inserted = store.runImmediate(() => {
        losers = scope ? store.unifyLiveKeys(scope.key, scope.roots) : [];
        const taken = store.listLiveSlots(key);
        const slot =
          isAllocatableSlot(preferred, maxActive) && !taken.includes(preferred)
            ? preferred
            : findFreeSlot(taken, maxActive);

        if (slot === null) {
          if (onExhausted === "throw") throw slotExhausted(maxActive);
          exhausted = true;
          return store.insert({ ...wt, projectPath: key, slot: null });
        }
        return store.insert({ ...wt, projectPath: key, slot });
      });

      if (exhausted) {
        warnings?.push(noFreeSlotWarning(key, maxActive));
      }
      if (scope && losers.length > 0) {
        warnings?.push(...reslotLosers(store, losers, scope, maxActive));
      }
      return inserted;
    } catch (err) {
      if (!isSlotRace(err)) throw err;
      lastRace = err;
    }
  }

  throw slotRaceError(key, lastRace);
}

// ─── Allocate + assign to an EXISTING row, atomically ───────────────────────

/** Outcome of {@link tryAssignFreeSlot}. `warning` is set iff `slot` is null. */
export interface AssignSlotResult {
  slot: number | null;
  warning?: string;
  /**
   * D4 collision warnings from re-slotting OTHER rows revealed by the re-key
   * (independent of `slot`). Callers that surface output should forward them.
   */
  notices?: string[];
}

/** Options for {@link tryAssignFreeSlot} — same scope contract as inserts. */
export interface AssignSlotOptions {
  scope?: SlotScope | null;
  listWorktrees?: WorktreeLister;
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
  opts: AssignSlotOptions = {},
): AssignSlotResult {
  // ⛔ git runs HERE, before the write lock — never inside runImmediate.
  const scope = scopeFor(projectPath, opts);
  const key = scope?.key ?? projectPath;
  let lastRace: unknown;

  for (let attempt = 0; attempt < SLOT_INSERT_ATTEMPTS; attempt++) {
    let losers: Worktree[] = [];
    try {
      const slot = store.runImmediate(() => {
        losers = scope
          ? store
              .unifyLiveKeys(scope.key, scope.roots)
              .filter((l) => l.id !== id) // this row is assigned below
          : [];
        const free = findFreeSlot(store.listLiveSlots(key), maxActive);
        if (free === null) return null;
        store.assignSlot(id, free);
        return free;
      });

      const notices =
        scope && losers.length > 0
          ? reslotLosers(store, losers, scope, maxActive)
          : undefined;
      const base: AssignSlotResult =
        slot === null
          ? { slot: null, warning: noFreeSlotWarning(key, maxActive) }
          : { slot };
      return notices ? { ...base, notices } : base;
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
 * D4 — re-slot the losers of a collision revealed by the canonical re-key.
 * Runs AFTER the unifying transaction commits, through the same path
 * `ensureSlot` uses: {@link tryAssignFreeSlot}, then a `worktree.env` rewrite
 * via `seedNonFatally` (Rule 0 still protects the loser's `.env`, which is why
 * the `warnIfSlotMismatch` wording tells the user to re-seed it).
 *
 * Returns the warnings; never throws.
 */
function reslotLosers(
  store: WorktreeStore,
  losers: Worktree[],
  scope: SlotScope,
  maxActive: number,
): string[] {
  const out: string[] = [];
  for (const loser of losers) {
    const held = loser.slot ?? null;
    const onDisk = readSlotFromWorktree(loser.worktreePath) ?? held;
    // `scope` is passed through: no second git call, and the re-key is a no-op.
    const r = tryAssignFreeSlot(store, loser.id, scope.key, maxActive, {
      scope,
    });
    if (r.notices) out.push(...r.notices);
    if (r.slot === null) {
      out.push(
        loserNotMovedWarning(loser.worktreePath, held, scope.key, r.warning),
      );
      continue;
    }
    if (existsSync(loser.worktreePath)) {
      // The same shared seeder `ensureSlot` calls. A static import: the
      // constants `worktree-config.ts` needs now live in the leaf `slot-env.ts`,
      // so there is no cycle back into this module.
      seedNonFatally(
        { repoRoot: scope.key, worktreePath: loser.worktreePath, slot: r.slot },
        out,
      );
    }
    warnIfSlotMismatch(out, loser.worktreePath, onDisk, r.slot);
  }
  return out;
}
