import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { runMigrations } from "./migrations.js";
import { DB_CONSTANTS } from "./types.js";

describe("runMigrations", () => {
  let tmpDir: string;
  let db: Database;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create all tables on a fresh database", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("observations");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("specs");
    expect(tableNames).toContain("spec_tasks");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("schema_version");
  });

  it("should set schema version to current", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("should be idempotent — running twice is safe", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);
    runMigrations(db, dbPath);

    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("should create FTS virtual table for observations", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create transcript_path column on sessions", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "transcript_path")).toBe(true);
  });

  it("should create notifications table (V6)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'",
      )
      .all();
    expect(tables).toHaveLength(1);

    const cols = db.prepare("PRAGMA table_info(notifications)").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("type");
    expect(colNames).toContain("title");
    expect(colNames).toContain("message");
    expect(colNames).toContain("source");
    expect(colNames).toContain("spec_id");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("read");
    expect(colNames).toContain("created_at");
  });

  it("should create indexes", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_obs_session");
    expect(indexNames).toContain("idx_obs_project");
    expect(indexNames).toContain("idx_specs_project");
    expect(indexNames).toContain("idx_spec_tasks_spec");
  });

  // ─── V8: quality_score column ───────────────────────────────────────

  it("should add quality_score column to observations (V8)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const cols = db.prepare("PRAGMA table_info(observations)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const qualityCol = cols.find((c) => c.name === "quality_score");

    expect(qualityCol).toBeDefined();
    expect(qualityCol!.dflt_value).toBe("1.0");
  });

  it("should create index on quality_score (V8)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_obs_quality'",
      )
      .all() as Array<{ name: string }>;

    expect(indexes).toHaveLength(1);
  });

  it("should backfill quality_score from metadata confidence (V8)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });

    // Create schema_version and set to 7 to simulate a pre-V8 database
    db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.run("INSERT INTO schema_version (version) VALUES (7)");

    // Create minimal observations table (V1 schema, no quality_score)
    db.run(`
      CREATE TABLE observations (
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
      )
    `);

    // Insert test observations with varying metadata
    db.run(`INSERT INTO observations (session_id, project_path, timestamp, type, title, content, metadata)
      VALUES ('s1', '/proj', 100, 'decision', 'With confidence', 'content', '{"confidence": 0.85}')`);
    db.run(`INSERT INTO observations (session_id, project_path, timestamp, type, title, content, metadata)
      VALUES ('s1', '/proj', 200, 'error', 'No confidence', 'content', '{}')`);
    db.run(`INSERT INTO observations (session_id, project_path, timestamp, type, title, content, metadata)
      VALUES ('s1', '/proj', 300, 'fix', 'Null metadata', 'content', 'null')`);

    // Run migrations — only V8 should apply (version is 7)
    runMigrations(db, dbPath);

    // Check backfilled values
    const rows = db
      .prepare("SELECT id, quality_score FROM observations ORDER BY id")
      .all() as Array<{ id: number; quality_score: number }>;

    expect(rows[0]!.quality_score).toBeCloseTo(0.85); // from metadata.confidence
    expect(rows[1]!.quality_score).toBe(1.0); // no confidence → default
    expect(rows[2]!.quality_score).toBe(1.0); // null metadata → default
  });

  it("should set schema version to 9 after V9 migration", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(9);

    // V9 adds parent and wave columns to specs
    const cols = db.prepare("PRAGMA table_info(specs)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "parent")).toBe(true);
    expect(cols.some((c) => c.name === "wave")).toBe(true);
  });
});
