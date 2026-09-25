/**
 * Migration V11 — sessions.last_active heartbeat column.
 */

import type { Database } from "bun:sqlite";

// ─── V11: sessions.last_active heartbeat column ──────────────────────────────

export function migrateV11(db: Database): void {
  // Guard: sessions table may not exist if DB was bootstrapped from a partial state
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
    )
    .all();
  if (tables.length > 0) {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "last_active")) {
      db.run("ALTER TABLE sessions ADD COLUMN last_active INTEGER");
    }
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active)",
    );
  }
  db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (11)");
}
