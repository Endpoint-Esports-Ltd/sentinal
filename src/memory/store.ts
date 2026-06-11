/**
 * Memory Store
 *
 * SQLite database layer for the persistent memory system.
 * Handles connection management and raw queries.
 * Migrations are in ./migrations.ts.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type {
  Observation,
  CreateObservation,
  Session,
  SearchFilters,
  MemoryStats,
  ObservationType,
  ListSessionsOptions,
  RawObservation,
  RawSession,
  Notification,
  NotificationType,
  RawNotification,
  TddCycle,
  TddCycleState,
  RawTddCycle,
  SpecEvent,
  SpecEventType,
  RawSpecEvent,
} from "./types.js";
import {
  DB_CONSTANTS,
  SEARCH_CONSTANTS,
  STALE_SESSION_THRESHOLD_MS,
  SESSION_LIVENESS_WINDOW_MS,
} from "./types.js";
import { runMigrations } from "./migrations.js";

// ─── Database Path ────────────────────────────────────────────────────────────

export function getDbPath(): string {
  const dir = join(homedir(), DB_CONSTANTS.DB_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, DB_CONSTANTS.DB_NAME);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath?: string) {
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

  // ─── Observations CRUD ────────────────────────────────────────────────

  insertObservation(obs: CreateObservation): Observation {
    const confidence =
      typeof obs.metadata?.confidence === "number"
        ? obs.metadata.confidence
        : null;
    const qualityScore =
      confidence != null && confidence > 0 && confidence <= 1
        ? confidence
        : 1.0;

    const stmt = this.db.prepare(`
      INSERT INTO observations (session_id, project_path, timestamp, type, title, content, file_paths, tags, metadata, quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.sessionId,
      obs.projectPath,
      obs.timestamp,
      obs.type,
      obs.title,
      obs.content,
      JSON.stringify(obs.filePaths),
      JSON.stringify(obs.tags),
      JSON.stringify(obs.metadata),
      qualityScore,
    );

    return this.getObservation(Number(result.lastInsertRowid))!;
  }

  getObservation(id: number): Observation | null {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE id = ?")
      .get(id) as RawObservation | null;
    return row ? this.deserializeObservation(row) : null;
  }

  getObservations(ids: number[]): Observation[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
      .all(...ids) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  deleteObservation(id: number): boolean {
    // Check existence first because bun:sqlite result.changes includes trigger-generated changes (FTS)
    const exists = this.db
      .prepare("SELECT 1 FROM observations WHERE id = ?")
      .get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM observations WHERE id = ?").run(id);
    return true;
  }

  getRecentForProject(
    projectPath: string,
    limit: number = SEARCH_CONSTANTS.DEFAULT_LIMIT,
  ): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM observations WHERE project_path = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(projectPath, limit) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── FTS Search ───────────────────────────────────────────────────────

  searchFTS(query: string, filters: SearchFilters): Observation[] {
    let sql = `
      SELECT o.*, rank
      FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
    `;
    const params: SQLQueryBindings[] = [query];

    sql += this.buildFilterClauses(filters, params);
    sql += ` ORDER BY ${filters.orderBy === "date_desc" ? "o.timestamp DESC" : filters.orderBy === "date_asc" ? "o.timestamp ASC" : "rank"} `;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(filters.limit, filters.offset);

    const rows = this.db.prepare(sql).all(...params) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── Filter-Only Search ───────────────────────────────────────────────

  searchFilters(filters: SearchFilters): Observation[] {
    let sql = `SELECT * FROM observations o WHERE 1=1`;
    const params: SQLQueryBindings[] = [];

    sql += this.buildFilterClauses(filters, params);
    sql += ` ORDER BY ${filters.orderBy === "date_asc" ? "o.timestamp ASC" : "o.timestamp DESC"} `;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(filters.limit, filters.offset);

    const rows = this.db.prepare(sql).all(...params) as RawObservation[];
    return rows.map((r) => this.deserializeObservation(r));
  }

  // ─── Timeline ─────────────────────────────────────────────────────────

  getTimelineAround(
    anchorId: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    projectPath?: string,
  ): {
    anchor: Observation | null;
    before: Observation[];
    after: Observation[];
  } {
    const anchor = this.getObservation(anchorId);
    if (!anchor) return { anchor: null, before: [], after: [] };

    let beforeSql = `SELECT * FROM observations WHERE timestamp < ? `;
    let afterSql = `SELECT * FROM observations WHERE timestamp > ? `;
    const beforeParams: SQLQueryBindings[] = [anchor.timestamp];
    const afterParams: SQLQueryBindings[] = [anchor.timestamp];

    if (projectPath) {
      beforeSql += ` AND project_path = ?`;
      afterSql += ` AND project_path = ?`;
      beforeParams.push(projectPath);
      afterParams.push(projectPath);
    }

    beforeSql += ` ORDER BY timestamp DESC LIMIT ?`;
    afterSql += ` ORDER BY timestamp ASC LIMIT ?`;
    beforeParams.push(depthBefore);
    afterParams.push(depthAfter);

    const before = (
      this.db.prepare(beforeSql).all(...beforeParams) as RawObservation[]
    )
      .map((r) => this.deserializeObservation(r))
      .reverse();

    const after = (
      this.db.prepare(afterSql).all(...afterParams) as RawObservation[]
    ).map((r) => this.deserializeObservation(r));

    return { anchor, before, after };
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  insertSession(session: Omit<Session, "observationCount" | "lastActive">): Session {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, start_time, end_time, project_path, assistant, summary, transcript_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.startTime,
        session.endTime,
        session.projectPath,
        session.assistant,
        session.summary,
        session.transcriptPath,
      );

    return this.getSession(session.id)!;
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as RawSession | null;
    return row ? this.deserializeSession(row) : null;
  }

  endSession(id: string, summary?: string): void {
    const obsCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM observations WHERE session_id = ?",
      )
      .get(id) as { count: number };

    this.db
      .prepare(
        `UPDATE sessions SET end_time = ?, summary = ?, observation_count = ? WHERE id = ?`,
      )
      .run(Date.now(), summary ?? null, obsCount.count, id);
  }

  getActiveSessions(): Session[] {
    return this.listSessions({ active: true });
  }

  listSessions(opts: ListSessionsOptions = {}): Session[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.active === true) clauses.push("end_time IS NULL");
    else if (opts.active === false) clauses.push("end_time IS NOT NULL");
    if (opts.project) {
      clauses.push("project_path = ?");
      params.push(opts.project);
    }
    if (opts.assistant) {
      clauses.push("assistant = ?");
      params.push(opts.assistant);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as RawSession[];
    return rows.map((r) => this.deserializeSession(r));
  }

  /**
   * Bump the last_active heartbeat for a session.
   * Called on every hook invocation that touches the session, and on Stop/idle.
   * @param id - Session ID
   * @param timestamp - Optional explicit timestamp (defaults to Date.now())
   */
  touchSession(id: string, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    this.db
      .prepare("UPDATE sessions SET last_active = ? WHERE id = ?")
      .run(ts, id);
  }

  /**
   * Determine whether a session is currently alive based on its last_active heartbeat.
   *
   * A session is alive when:
   * 1. end_time IS NULL (session not explicitly ended), AND
   * 2. last_active is within the liveness window (falls back to start_time when last_active IS NULL
   *    for pre-V11 rows — null start_time treated as infinitely stale).
   *
   * isSessionAlive is the SOLE liveness authority for the stop-guard decision.
   * cleanupStaleSessions (start_time-based) is a separate cleanup path and is
   * not consulted here — intentionally avoids a dual-source-of-truth.
   *
   * @param id - Session ID
   * @param withinMs - Liveness window in ms (defaults to SESSION_LIVENESS_WINDOW_MS = 45 min)
   */
  isSessionAlive(id: string, withinMs: number = SESSION_LIVENESS_WINDOW_MS): boolean {
    const row = this.db
      .prepare("SELECT end_time, last_active, start_time FROM sessions WHERE id = ?")
      .get(id) as { end_time: number | null; last_active: number | null; start_time: number } | null;

    if (!row) return false;
    if (row.end_time !== null) return false; // explicitly ended

    const cutoff = Date.now() - withinMs;
    // Prefer last_active; fall back to start_time for pre-V11 rows
    const heartbeat = row.last_active ?? row.start_time;
    return heartbeat >= cutoff;
  }

  /**
   * Stamp a session as the owner of a spec row (only when spec has no owner yet).
   * Uses a conditional UPDATE so it never overwrites an existing owner.
   * This is idempotent — calling multiple times with the same session ID is safe.
   */
  stampPlanOwner(specId: string, sessionId: string): void {
    this.db
      .prepare(
        "UPDATE specs SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = '')",
      )
      .run(sessionId, specId);
  }

  cleanupStaleSessions(
    thresholdMs: number = STALE_SESSION_THRESHOLD_MS,
  ): number {
    const cutoff = Date.now() - thresholdMs;
    return this.db
      .prepare(
        "UPDATE sessions SET end_time = ? WHERE end_time IS NULL AND start_time < ?",
      )
      .run(Date.now(), cutoff).changes;
  }

  // ─── Notifications ────────────────────────────────────────────────────

  insertNotification(notif: {
    type: NotificationType;
    title: string;
    message?: string | null;
    source?: string | null;
    specId?: string | null;
    sessionId?: string | null;
  }): Notification {
    const result = this.db
      .prepare(
        `INSERT INTO notifications (type, title, message, source, spec_id, session_id, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        notif.type,
        notif.title,
        notif.message ?? null,
        notif.source ?? null,
        notif.specId ?? null,
        notif.sessionId ?? null,
        Date.now(),
      );
    return this.getNotification(Number(result.lastInsertRowid))!;
  }

  private getNotification(id: number): Notification | null {
    const row = this.db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(id) as RawNotification | null;
    return row ? this.deserializeNotification(row) : null;
  }

  getNotifications(
    opts: {
      unread?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Notification[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.unread === true) {
      clauses.push("read = 0");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as RawNotification[];
    return rows.map((r) => this.deserializeNotification(r));
  }

  markNotificationRead(id: number): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
  }

  markAllNotificationsRead(): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  }

  getUnreadNotificationCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
      .get() as { count: number };
    return row.count;
  }

  deleteOldNotifications(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const { count } = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM notifications WHERE created_at < ?",
      )
      .get(cutoff) as { count: number };
    if (count > 0) {
      this.db
        .prepare("DELETE FROM notifications WHERE created_at < ?")
        .run(cutoff);
    }
    return count;
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
    // Count first because bun:sqlite result.changes includes trigger-generated changes (FTS)
    const { count } = this.db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE timestamp < ?")
      .get(cutoff) as { count: number };
    if (count > 0) {
      this.db
        .prepare("DELETE FROM observations WHERE timestamp < ?")
        .run(cutoff);
    }
    return count;
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

  private buildFilterClauses(
    filters: SearchFilters,
    params: SQLQueryBindings[],
  ): string {
    let sql = "";

    if (filters.project) {
      sql += ` AND o.project_path = ?`;
      params.push(filters.project);
    }
    if (filters.type) {
      sql += ` AND o.type = ?`;
      params.push(filters.type);
    }
    if (filters.types && filters.types.length > 0) {
      const placeholders = filters.types.map(() => "?").join(",");
      sql += ` AND o.type IN (${placeholders})`;
      params.push(...filters.types);
    }
    if (filters.dateStart) {
      sql += ` AND o.timestamp >= ?`;
      params.push(filters.dateStart);
    }
    if (filters.dateEnd) {
      sql += ` AND o.timestamp <= ?`;
      params.push(filters.dateEnd);
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        sql += ` AND o.tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    return sql;
  }

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

  private deserializeObservation(row: RawObservation): Observation {
    return {
      id: row.id,
      sessionId: row.session_id,
      projectPath: row.project_path,
      timestamp: row.timestamp,
      type: row.type as ObservationType,
      title: row.title,
      content: row.content,
      filePaths: JSON.parse(row.file_paths || "[]"),
      tags: JSON.parse(row.tags || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      qualityScore: row.quality_score ?? 1.0,
    };
  }

  private deserializeNotification(row: RawNotification): Notification {
    return {
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      message: row.message,
      source: row.source,
      specId: row.spec_id,
      sessionId: row.session_id,
      read: row.read === 1,
      createdAt: row.created_at,
    };
  }

  private deserializeSession(row: RawSession): Session {
    return {
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      projectPath: row.project_path,
      assistant: row.assistant as Session["assistant"],
      observationCount: row.observation_count,
      summary: row.summary,
      transcriptPath: row.transcript_path,
      lastActive: row.last_active ?? null,
    };
  }
}
