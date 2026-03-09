/**
 * Memory Store
 *
 * SQLite database layer for the persistent memory system.
 * Handles connection management, schema migrations, and raw queries.
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
} from "./types.js";
import { DB_CONSTANTS, SEARCH_CONSTANTS, STALE_SESSION_THRESHOLD_MS } from "./types.js";
import { backupDatabase } from "./maintenance.js";

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
    this.runMigrations();
  }

  // ─── Migrations ───────────────────────────────────────────────────────

  private runMigrations(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | null;
    const currentVersion = row?.version ?? 0;

    // Backup before applying migrations (skip for fresh databases)
    if (currentVersion > 0 && currentVersion < DB_CONSTANTS.SCHEMA_VERSION) {
      try {
        backupDatabase(this.dbPath);
      } catch {
        // Backup failure should not block migration
      }
    }

    if (currentVersion < 1) {
      this.migrateV1();
    }
    if (currentVersion < 2) {
      this.migrateV2();
    }
    if (currentVersion < 3) {
      this.migrateV3();
    }
    if (currentVersion < 4) {
      this.migrateV4();
    }
  }

  private migrateV1(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        file_paths TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        project_path TEXT NOT NULL,
        assistant TEXT NOT NULL,
        observation_count INTEGER DEFAULT 0,
        summary TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, content, tags, content=observations, content_rowid=id
      );

      -- FTS triggers to keep index in sync
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO observations_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
      CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_path);
      CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

      INSERT OR REPLACE INTO schema_version (version) VALUES (1);
    `);
  }

  private migrateV2(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS specs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        approved INTEGER DEFAULT 0,
        plan_file TEXT NOT NULL,
        task_count INTEGER DEFAULT 0,
        tasks_done INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spec_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE(spec_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_specs_project ON specs(project_path);
      CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);
      CREATE INDEX IF NOT EXISTS idx_spec_tasks_spec ON spec_tasks(spec_id);

      INSERT OR REPLACE INTO schema_version (version) VALUES (2);
    `);
  }

  private migrateV3(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT OR REPLACE INTO schema_version (version) VALUES (3);
    `);
  }

  private migrateV4(): void {
    // Add transcript_path column to sessions table
    // ALTER TABLE ADD COLUMN defaults to NULL for existing rows
    // Check if column already exists before altering (idempotent)
    const cols = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "transcript_path")) {
      this.db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
    }
    this.db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (4)");
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
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  // ─── Observations CRUD ────────────────────────────────────────────────

  insertObservation(obs: CreateObservation): Observation {
    const stmt = this.db.prepare(`
      INSERT INTO observations (session_id, project_path, timestamp, type, title, content, file_paths, tags, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  ): { anchor: Observation | null; before: Observation[]; after: Observation[] } {
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

  insertSession(session: Omit<Session, "observationCount">): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (id, start_time, end_time, project_path, assistant, summary, transcript_path)
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
    if (opts.project) { clauses.push("project_path = ?"); params.push(opts.project); }
    if (opts.assistant) { clauses.push("assistant = ?"); params.push(opts.assistant); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as RawSession[];
    return rows.map((r) => this.deserializeSession(r));
  }

  cleanupStaleSessions(thresholdMs: number = STALE_SESSION_THRESHOLD_MS): number {
    const cutoff = Date.now() - thresholdMs;
    return this.db
      .prepare("UPDATE sessions SET end_time = ? WHERE end_time IS NULL AND start_time < ?")
      .run(Date.now(), cutoff).changes;
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
      .prepare(
        "SELECT type, COUNT(*) as count FROM observations GROUP BY type",
      )
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
      this.db.prepare("DELETE FROM observations WHERE timestamp < ?").run(cutoff);
    }
    return count;
  }

  close(): void {
    this.db.close();
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
    };
  }
}

// ─── Raw DB Row Types ─────────────────────────────────────────────────────────

interface RawObservation {
  id: number;
  session_id: string;
  project_path: string;
  timestamp: number;
  type: string;
  title: string;
  content: string;
  file_paths: string;
  tags: string;
  metadata: string;
}

interface RawSession {
  id: string;
  start_time: number;
  end_time: number | null;
  project_path: string;
  assistant: string;
  observation_count: number;
  summary: string | null;
  transcript_path: string | null;
}
