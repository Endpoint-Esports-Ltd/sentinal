/**
 * Migration V15 — worktree ownership (D1 of the Orca orchestration plan).
 *
 * Adds `worktrees.owner TEXT NOT NULL DEFAULT 'sentinal'` (who may delete the
 * directory and branch: Sentinal, or an external tool such as Orca) and
 * `worktrees.slug TEXT` (the plan slug a worktree was ensured under, for rows
 * whose branch does not carry Sentinal's prefix), plus a NON-unique index on
 * `(project_path, slug)`.
 *
 * ⛔ Non-unique on purpose: `unifyLiveKeys` re-keys `project_path` of every
 * live row of a repo, and a unique `(project_path, slug)` could fail that
 * re-key the way `idx_wt_slot_live` can — terminal rows keep their slug.
 *
 * Existing rows become `owner = 'sentinal'`: current behaviour is unchanged.
 *
 * Runs in ONE transaction; version 15 is recorded only after the columns and
 * the index are verified. ⛔ Never throws out of the MemoryStore constructor:
 * a failure rolls back, is logged, and the next start retries.
 */

import type { Database } from "bun:sqlite";
import { hasColumn, hasSqliteObject } from "./migration-helpers.js";

const SLUG_INDEX = "idx_worktrees_project_slug";

export function migrateV15(db: Database): void {
  // Guard: no worktrees table yet → do NOT record, retry on a later start.
  if (!hasSqliteObject(db, "table", "worktrees")) return;

  try {
    db.transaction(() => {
      if (!hasColumn(db, "worktrees", "owner")) {
        db.run(
          "ALTER TABLE worktrees ADD COLUMN owner TEXT NOT NULL DEFAULT 'sentinal'",
        );
      }
      if (!hasColumn(db, "worktrees", "slug")) {
        db.run("ALTER TABLE worktrees ADD COLUMN slug TEXT");
      }
      db.run(
        `CREATE INDEX IF NOT EXISTS ${SLUG_INDEX} ON worktrees(project_path, slug)`,
      );

      if (
        !hasColumn(db, "worktrees", "owner") ||
        !hasColumn(db, "worktrees", "slug") ||
        !hasSqliteObject(db, "index", SLUG_INDEX)
      ) {
        throw new Error("owner/slug columns or slug index missing after ALTER");
      }
      db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (15)");
    })();
  } catch (err) {
    console.error(
      `[sentinal] migration V15 (worktree owner/slug) rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
