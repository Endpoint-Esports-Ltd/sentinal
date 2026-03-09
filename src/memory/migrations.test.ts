import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrations } from "./migrations.js";
import { DB_CONSTANTS } from "./types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sentinal-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
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

    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("should be idempotent — running twice is safe", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);
    runMigrations(db, dbPath);

    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("should create FTS virtual table for observations", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create transcript_path column on sessions", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "transcript_path")).toBe(true);
  });

  it("should create indexes", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_obs_session");
    expect(indexNames).toContain("idx_obs_project");
    expect(indexNames).toContain("idx_specs_project");
    expect(indexNames).toContain("idx_spec_tasks_spec");
  });
});
