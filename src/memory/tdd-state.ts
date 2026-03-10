/**
 * Lightweight TDD State Reader
 *
 * A minimal, read-only SQLite accessor for TDD cycle state.
 * Used by the tdd-guard PreToolUse hook to avoid the full MemoryStore
 * initialization overhead (~10ms → ~2ms).
 *
 * Does NOT use MemoryStore, runMigrations, or PRAGMA setup.
 * Opens the DB read-only, runs a single SELECT, then closes.
 * Falls back to "IDLE" on any error (DB missing, table missing, etc.).
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "./store.js";
import type { TddCycleState } from "./types.js";

/**
 * Read the TDD cycle state for a specific implementation file.
 * Returns "IDLE" if no state record exists or if the DB is unavailable.
 */
export function readTddState(filePath: string, dbPath?: string): TddCycleState {
  let db: Database | null = null;
  try {
    db = new Database(dbPath ?? getDbPath(), { readonly: true });
    const row = db
      .query<{ state: string }, [string]>(
        "SELECT state FROM tdd_cycles WHERE file_path = ?",
      )
      .get(filePath);
    return (row?.state as TddCycleState) ?? "IDLE";
  } catch {
    // DB doesn't exist yet, table not created yet, or other error — treat as IDLE
    return "IDLE";
  } finally {
    db?.close();
  }
}
