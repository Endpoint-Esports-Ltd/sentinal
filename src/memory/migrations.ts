/**
 * Database Migrations
 *
 * Sequential migration functions for the Sentinal SQLite schema.
 * Extracted from MemoryStore to keep file sizes manageable.
 */

import type { Database } from "bun:sqlite";
import { DB_CONSTANTS } from "./types.js";
import { backupDatabase } from "./maintenance.js";

// ─── Migration Runner ─────────────────────────────────────────────────────────

export function runMigrations(db: Database, dbPath: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db
    .prepare("SELECT MAX(version) as version FROM schema_version")
    .get() as { version: number | null } | null;
  const currentVersion = row?.version ?? 0;

  // Backup before applying migrations (skip for fresh databases)
  if (currentVersion > 0 && currentVersion < DB_CONSTANTS.SCHEMA_VERSION) {
    try {
      backupDatabase(dbPath);
    } catch {
      // Backup failure should not block migration
    }
  }

  if (currentVersion < 1) migrateV1(db);
  if (currentVersion < 2) migrateV2(db);
  if (currentVersion < 3) migrateV3(db);
  if (currentVersion < 4) migrateV4(db);
  if (currentVersion < 5) migrateV5(db);
  if (currentVersion < 6) migrateV6(db);
}

// ─── V1: Core tables (observations, sessions, FTS) ───────────────────────────

function migrateV1(db: Database): void {
  db.run(`
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

// ─── V2: Specs + spec_tasks tables ───────────────────────────────────────────

function migrateV2(db: Database): void {
  db.run(`
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

// ─── V3: Settings table ─────────────────────────────────────────────────────

function migrateV3(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT OR REPLACE INTO schema_version (version) VALUES (3);
  `);
}

// ─── V4: transcript_path on sessions ────────────────────────────────────────

function migrateV4(db: Database): void {
  const cols = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "transcript_path")) {
    db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
  }
  db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (4)");
}

// ─── V6: Notifications table ────────────────────────────────────────────────

function migrateV6(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      source TEXT,
      spec_id TEXT REFERENCES specs(id),
      session_id TEXT,
      read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);

    INSERT OR REPLACE INTO schema_version (version) VALUES (6);
  `);
}

// ─── V5: session_id + metadata on specs, worktrees table ────────────────────

function migrateV5(db: Database): void {
  // Add session_id and metadata columns to specs table (idempotent)
  const specCols = db
    .prepare("PRAGMA table_info(specs)")
    .all() as Array<{ name: string }>;

  if (!specCols.some((c) => c.name === "session_id")) {
    db.run("ALTER TABLE specs ADD COLUMN session_id TEXT");
  }
  if (!specCols.some((c) => c.name === "metadata")) {
    db.run("ALTER TABLE specs ADD COLUMN metadata TEXT DEFAULT '{}'");
  }

  // Create worktrees table
  db.run(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      spec_id TEXT REFERENCES specs(id),
      project_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      merged_at INTEGER,
      merge_commit TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wt_project ON worktrees(project_path);
    CREATE INDEX IF NOT EXISTS idx_wt_status ON worktrees(status);
    CREATE INDEX IF NOT EXISTS idx_wt_spec ON worktrees(spec_id);

    INSERT OR REPLACE INTO schema_version (version) VALUES (5);
  `);
}
