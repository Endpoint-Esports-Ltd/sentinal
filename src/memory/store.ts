/**
 * Memory Store
 *
 * SQLite database layer for the persistent memory system.
 * Handles connection management and raw queries.
 * Migrations are in ./migrations.ts.
 *
 * Split for file length (Task 6a of
 * docs/plans/2026-09-01-audit-high-remediation.md) using the
 * `src/sidecar/client.ts` inverted-inheritance precedent:
 * `MemoryStore` extends `MemoryStoreObservations` extends
 * `MemoryStoreSessions`, so callers still see a single class. DB path
 * resolution lives in `./db-path.ts` (re-exported here so no import path
 * changes anywhere).
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type {
  MemoryStats,
  ObservationType,
  TddCycle,
  TddCycleState,
  RawTddCycle,
  SpecEvent,
  SpecEventType,
  RawSpecEvent,
} from "./types.js";
import { runMigrations } from "./migrations.js";
import { getDbPath } from "./db-path.js";
import { MemoryStoreObservations } from "./store-observations.js";
import { deleteVectorRowsForObservation } from "./vector-cleanup.js";

// ─── Database Path ────────────────────────────────────────────────────────────

export { getDbPath } from "./db-path.js";

// ─── Store ────────────────────────────────────────────────────────────────────

export class MemoryStore extends MemoryStoreObservations {
  constructor(dbPath?: string) {
    super();
    this.dbPath = dbPath ?? getDbPath();
    this.db = new Database(this.dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    runMigrations(this.db, this.dbPath);
  }

  // ─── Settings CRUD ────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .run(key, value, Date.now());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  listSettings(): Array<{ key: string; value: string; updatedAt: number }> {
    const rows = this.db
      .prepare("SELECT key, value, updated_at FROM settings ORDER BY key")
      .all() as Array<{ key: string; value: string; updated_at: number }>;
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at,
    }));
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  getStats(): MemoryStats {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM observations")
      .get() as { count: number };
    const sessions = this.db
      .prepare("SELECT COUNT(*) as count FROM sessions")
      .get() as { count: number };

    const byTypeRows = this.db
      .prepare("SELECT type, COUNT(*) as count FROM observations GROUP BY type")
      .all() as { type: ObservationType; count: number }[];
    const byType = Object.fromEntries(
      byTypeRows.map((r) => [r.type, r.count]),
    ) as Record<ObservationType, number>;

    const byProjectRows = this.db
      .prepare(
        "SELECT project_path, COUNT(*) as count FROM observations GROUP BY project_path",
      )
      .all() as { project_path: string; count: number }[];
    const byProject = Object.fromEntries(
      byProjectRows.map((r) => [r.project_path, r.count]),
    );

    const range = this.db
      .prepare(
        "SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM observations",
      )
      .get() as { oldest: number | null; newest: number | null };

    let databaseSizeBytes = 0;
    try {
      databaseSizeBytes = statSync(this.dbPath).size;
    } catch {
      // DB might be in-memory
    }

    return {
      totalObservations: total.count,
      totalSessions: sessions.count,
      byType,
      byProject,
      oldestTimestamp: range.oldest,
      newestTimestamp: range.newest,
      databaseSizeBytes,
    };
  }

  // ─── Maintenance ──────────────────────────────────────────────────────

  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    // Collect the doomed IDs first so vector rows can be removed per ID
    // BEFORE the observation delete (M6a) — a raw DELETE would orphan them.
    const doomed = this.db
      .prepare("SELECT id FROM observations WHERE timestamp < ?")
      .all(cutoff) as { id: number }[];
    return this.deleteObservationsByIds(doomed.map((r) => r.id));
  }

  /**
   * Delete a batch of observations by ID, removing each observation's vector
   * rows FIRST (best-effort — see ./vector-cleanup.ts) so no prune path
   * leaves orphans in `observation_vectors`. FTS stays in sync via the
   * delete trigger. Returns the number of observations deleted.
   */
  deleteObservationsByIds(ids: number[]): number {
    if (ids.length === 0) return 0;
    // Chunk to stay under SQLite's bound-parameter limit.
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      for (const id of chunk) {
        deleteVectorRowsForObservation(this.db, id);
      }
      const placeholders = chunk.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM observations WHERE id IN (${placeholders})`)
        .run(...chunk);
    }
    return ids.length;
  }

  close(): void {
    this.db.close();
  }

  // ─── TDD Cycle State ──────────────────────────────────────────────────

  /** Get TDD cycle state for a file path. Returns null if no record. */
  getTddState(filePath: string): TddCycle | null {
    const row = this.db
      .prepare("SELECT * FROM tdd_cycles WHERE file_path = ?")
      .get(filePath) as RawTddCycle | null;
    return row ? this.deserializeTddCycle(row) : null;
  }

  /** Upsert TDD cycle state for a file path. */
  setTddState(opts: {
    filePath: string;
    state: TddCycleState;
    specId?: string | null;
    taskPosition?: number | null;
    testFilePath?: string | null;
    lastFailOutput?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tdd_cycles (file_path, spec_id, task_position, state, test_file_path, last_fail_output, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           state = excluded.state,
           spec_id = COALESCE(excluded.spec_id, spec_id),
           task_position = COALESCE(excluded.task_position, task_position),
           test_file_path = COALESCE(excluded.test_file_path, test_file_path),
           last_fail_output = COALESCE(excluded.last_fail_output, last_fail_output),
           updated_at = excluded.updated_at`,
      )
      .run(
        opts.filePath,
        opts.specId ?? null,
        opts.taskPosition ?? null,
        opts.state,
        opts.testFilePath ?? null,
        opts.lastFailOutput ?? null,
        Date.now(),
      );
  }

  /** Remove TDD cycle state for a specific file. */
  clearTddState(filePath: string): void {
    this.db.prepare("DELETE FROM tdd_cycles WHERE file_path = ?").run(filePath);
  }

  /** Remove all TDD cycle states associated with a spec. */
  clearTddStatesForSpec(specId: string): void {
    this.db.prepare("DELETE FROM tdd_cycles WHERE spec_id = ?").run(specId);
  }

  /** List all active (non-IDLE) TDD cycle states, optionally scoped to a spec. */
  listActiveTddStates(specId?: string | null): TddCycle[] {
    let rows: RawTddCycle[];
    if (specId) {
      rows = this.db
        .prepare(
          "SELECT * FROM tdd_cycles WHERE spec_id = ? AND state != 'IDLE' ORDER BY updated_at DESC",
        )
        .all(specId) as RawTddCycle[];
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM tdd_cycles WHERE state != 'IDLE' ORDER BY updated_at DESC",
        )
        .all() as RawTddCycle[];
    }
    return rows.map((r) => this.deserializeTddCycle(r));
  }

  // ─── Spec Events ──────────────────────────────────────────────────────

  /** Log a spec lifecycle event. */
  logSpecEvent(opts: {
    specId: string;
    sessionId?: string | null;
    eventType: SpecEventType;
    details: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO spec_events (spec_id, session_id, timestamp, event_type, details)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.specId,
        opts.sessionId ?? null,
        Date.now(),
        opts.eventType,
        JSON.stringify(opts.details),
      );
  }

  /** Get recent spec events, newest first. */
  getSpecEvents(specId: string, limit: number = 50): SpecEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM spec_events WHERE spec_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?",
      )
      .all(specId, limit) as RawSpecEvent[];
    return rows.map((r) => this.deserializeSpecEvent(r));
  }

  /** Expose the raw database for extensions (e.g., sqlite-vec) */
  getRawDb(): Database {
    return this.db;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private deserializeTddCycle(row: RawTddCycle): TddCycle {
    return {
      id: row.id,
      filePath: row.file_path,
      specId: row.spec_id,
      taskPosition: row.task_position,
      state: row.state as TddCycleState,
      testFilePath: row.test_file_path,
      lastFailOutput: row.last_fail_output,
      updatedAt: row.updated_at,
    };
  }

  private deserializeSpecEvent(row: RawSpecEvent): SpecEvent {
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(row.details);
    } catch {
      // Malformed JSON — fall back to empty
    }
    return {
      id: row.id,
      specId: row.spec_id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      eventType: row.event_type as SpecEventType,
      details,
    };
  }
}
