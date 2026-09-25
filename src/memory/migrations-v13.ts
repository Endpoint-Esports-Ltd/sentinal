/**
 * Migration V13 — project_path on tdd_cycles + notifications.
 */

import type { Database } from "bun:sqlite";
import { hasColumn, hasSqliteObject } from "./migration-helpers.js";

// ─── V13: project_path on tdd_cycles + notifications ─────────────────────────

/**
 * Adds a nullable `project_path` (+ index) to `tdd_cycles` and `notifications`,
 * so cross-project operations become expressible.
 *
 * ⛔ D1: every pre-existing `tdd_cycles` row (i.e. `project_path IS NULL`) is
 * DELETED, not backfilled. `RED_CONFIRMED` is the TDD guard's BYPASS state, so
 * a surviving NULL-project RED row would leave that file permanently exempt
 * from enforcement. The table is transient in-flight state; the count is
 * logged to stderr (stdout carries hook JSON, so it must stay clean).
 *
 * Pre-existing `notifications` rows survive with NULL `project_path` — they
 * are historical and non-destructive.
 *
 * Follows migrateV12, NOT migrateV11: the version is recorded only once every
 * artifact verifiably exists, so a skipped guard retries on the next run.
 */
export function migrateV13(db: Database, backupPath: string | null): void {
  if (!hasSqliteObject(db, "table", "tdd_cycles")) return;
  if (!hasSqliteObject(db, "table", "notifications")) return;

  let deleted = 0;
  db.transaction(() => {
    if (!hasColumn(db, "tdd_cycles", "project_path")) {
      db.run("ALTER TABLE tdd_cycles ADD COLUMN project_path TEXT");
    }
    if (!hasColumn(db, "notifications", "project_path")) {
      db.run("ALTER TABLE notifications ADD COLUMN project_path TEXT");
    }
    deleted = db.run(
      "DELETE FROM tdd_cycles WHERE project_path IS NULL",
    ).changes;
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_tdd_cycles_project ON tdd_cycles(project_path)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_notif_project ON notifications(project_path)",
    );
  })();

  if (deleted > 0) {
    console.error(
      `[sentinal] database upgraded to schema v13: cleared ${deleted} TDD cycle record(s) from before per-project tracking — TDD state restarts for those files. ` +
        (backupPath ? `Backup: ${backupPath}` : "(backup unavailable)"),
    );
  }

  if (!hasColumn(db, "tdd_cycles", "project_path")) return;
  if (!hasColumn(db, "notifications", "project_path")) return;
  if (!hasSqliteObject(db, "index", "idx_tdd_cycles_project")) return;
  if (!hasSqliteObject(db, "index", "idx_notif_project")) return;

  db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (13)");
}
