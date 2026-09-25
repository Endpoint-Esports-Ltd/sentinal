/**
 * Migration V12 — worktrees.slot + partial unique index over the LIVE status set.
 */

import type { Database } from "bun:sqlite";

// ─── V12: worktrees.slot + partial unique index over the LIVE status set ─────

/**
 * Adds `worktrees.slot`, an integer unique among the **live** worktrees of one
 * project (D2). Slot 0 is reserved for the developer's main checkout (D7) and
 * is never allocated — that is an allocator rule, not a schema constraint.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 * 1. **Uniqueness is a partial unique index, not a column constraint.** SQLite
 *    cannot `ALTER TABLE ... ADD COLUMN ... UNIQUE`.
 *
 * 2. **⛔ The predicate covers `('active','ready-to-merge')`, not `'active'`.**
 *    `ready-to-merge` is a LIVE status — the worktree directory still exists,
 *    its seeded `.env` is still there, and its processes may still be running
 *    (see `WORKTREE_STATUSES`, and `manager.squashMerge` which accepts either).
 *    Scoping to `'active'` alone would free a live worktree's slot and hand it
 *    to a second worktree with colliding ports and database names — precisely
 *    the collision this migration exists to prevent.
 *
 * Release of a slot is therefore **emergent**: moving a row to `merged` /
 * `abandoned`, or deleting it, drops it out of the index. No code writes `slot`
 * after insert.
 *
 * Pre-V12 rows keep `slot = NULL` — no backfill. That is safe only because
 * SQLite treats NULLs as distinct in unique indexes, so N unslotted live rows
 * coexist. Such rows are allocated lazily on next resolve.
 */
export function migrateV12(db: Database): void {
  // Guard: the worktrees table (V5) may be absent on a partially-bootstrapped DB.
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='worktrees'",
    )
    .all();
  // ⚠️ Unlike migrateV11, do NOT bump the version when the guard skips. V11
  // bumps unconditionally, so a DB could record the version with none of the
  // work done and then never re-run the migration. Returning here leaves the
  // version behind so the next run retries.
  if (tables.length === 0) return;

  const cols = db.prepare("PRAGMA table_info(worktrees)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "slot")) {
    db.run("ALTER TABLE worktrees ADD COLUMN slot INTEGER");
  }

  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_slot_live
       ON worktrees(project_path, slot)
       WHERE status IN ('active', 'ready-to-merge')`,
  );

  // Record the version only once both artifacts verifiably exist.
  const after = db.prepare("PRAGMA table_info(worktrees)").all() as Array<{
    name: string;
  }>;
  if (!after.some((c) => c.name === "slot")) return;
  const idx = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_wt_slot_live'",
    )
    .all();
  if (idx.length === 0) return;

  db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (12)");
}
