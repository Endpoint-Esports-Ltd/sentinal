import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
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

  it("should have V9/V10 columns and set schema version to current (11)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION); // 11

    // V9 adds parent and wave columns to specs
    const cols = db.prepare("PRAGMA table_info(specs)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "parent")).toBe(true);
    expect(cols.some((c) => c.name === "wave")).toBe(true);

    // V10 adds started_at and completed_at to specs
    expect(cols.some((c) => c.name === "started_at")).toBe(true);
    expect(cols.some((c) => c.name === "completed_at")).toBe(true);

    // V11 adds last_active to sessions
    const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    expect(sessCols.some((c) => c.name === "last_active")).toBe(true);
  });
});

// ─── V13: tdd_cycles.project_path + notifications.project_path ─────────────

describe("migrateV13", () => {
  let tmpDir: string;
  let db: Database;
  let errSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    errSpy?.mockRestore();
    errSpy = undefined;
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  const colNames = (table: string): string[] =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
  const version = (): number =>
    (
      db
        .prepare("SELECT MAX(version) as version FROM schema_version")
        .get() as {
        version: number;
      }
    ).version;
  const indexExists = (name: string): boolean =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .all(name).length === 1;

  /** A v12-shaped DB: V6 notifications + V7 tdd_cycles DDL, no project_path. */
  function seedV12(
    opts: { withTdd?: boolean; withNotif?: boolean } = {},
  ): string {
    const { withTdd = true, withNotif = true } = opts;
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.run("INSERT INTO schema_version (version) VALUES (12)");
    if (withNotif) {
      db.run(`CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
        title TEXT NOT NULL, message TEXT, source TEXT, spec_id TEXT,
        session_id TEXT, read INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`);
      db.run(
        "INSERT INTO notifications (type, title, created_at) VALUES ('info', 'old-1', 1), ('warning', 'old-2', 2)",
      );
    }
    if (withTdd) {
      db.run(`CREATE TABLE tdd_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE,
        spec_id TEXT, task_position INTEGER, state TEXT NOT NULL DEFAULT 'IDLE',
        test_file_path TEXT, last_fail_output TEXT, updated_at INTEGER NOT NULL)`);
      db.run(`INSERT INTO tdd_cycles (file_path, state, updated_at) VALUES
        ('/a/x.ts', 'RED_CONFIRMED', 1), ('/b/y.ts', 'TEST_WRITTEN', 2),
        ('rel/z.ts', 'GREEN_CONFIRMED', 3)`);
    }
    return dbPath;
  }

  it("SCHEMA_VERSION is at least 13 (V14 is covered in migrations-v14.test.ts)", () => {
    expect(DB_CONSTANTS.SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
  });

  it("adds project_path + index to tdd_cycles and notifications on a fresh DB", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    expect(colNames("tdd_cycles")).toContain("project_path");
    expect(colNames("notifications")).toContain("project_path");
    expect(indexExists("idx_tdd_cycles_project")).toBe(true);
    expect(indexExists("idx_notif_project")).toBe(true);
    expect(version()).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("migrates a v12 DB: deletes all pre-existing tdd_cycles rows and logs the count (D1)", () => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    const dbPath = seedV12();
    runMigrations(db, dbPath);

    expect(version()).toBe(13);
    expect(colNames("tdd_cycles")).toContain("project_path");
    const n = db.prepare("SELECT COUNT(*) AS n FROM tdd_cycles").get() as {
      n: number;
    };
    expect(n.n).toBe(0);

    const logged = errSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .join("\n");
    expect(logged).toContain("[sentinal] database upgraded to schema v13");
    expect(logged).toContain(
      "cleared 3 TDD cycle record(s) from before per-project tracking",
    );
    expect(logged).toContain("TDD state restarts for those files");
    // Names the backup that runMigrations took before migrating.
    expect(logged).toContain(`Backup: ${dbPath}.bak`);
    expect(existsSync(`${dbPath}.bak`)).toBe(true);
    // No internal plan labels or raw column names leak to the user.
    expect(logged).not.toContain("(D1)");
    expect(logged).not.toContain("project_path");
  });

  it("says '(backup unavailable)' when no backup could be taken", () => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    seedV12();
    // ":memory:" makes backupDatabase return null (nothing on disk to copy).
    runMigrations(db, ":memory:");

    const logged = errSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .join("\n");
    expect(logged).toContain("cleared 3 TDD cycle record(s)");
    expect(logged).toContain("(backup unavailable)");
    expect(logged).not.toContain("Backup: ");
  });

  it("migrates a v12 DB: pre-existing notifications survive with NULL project_path", () => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    const dbPath = seedV12();
    runMigrations(db, dbPath);

    const rows = db
      .prepare("SELECT title, project_path FROM notifications ORDER BY id")
      .all() as Array<{ title: string; project_path: string | null }>;
    expect(rows).toEqual([
      { title: "old-1", project_path: null },
      { title: "old-2", project_path: null },
    ]);
  });

  it("new tdd_cycles rows written after V13 are not deleted by a re-run (idempotent)", () => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    const dbPath = seedV12();
    runMigrations(db, dbPath);
    db.run(
      "INSERT INTO tdd_cycles (file_path, state, updated_at, project_path) VALUES ('/p/new.ts', 'RED_CONFIRMED', 9, '/p')",
    );
    errSpy.mockClear();

    runMigrations(db, dbPath);

    const n = db.prepare("SELECT COUNT(*) AS n FROM tdd_cycles").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
    expect(version()).toBe(13);
    expect(
      colNames("tdd_cycles").filter((c) => c === "project_path"),
    ).toHaveLength(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("does NOT bump the version when tdd_cycles is missing (guard skips → retries next run)", () => {
    const dbPath = seedV12({ withTdd: false });
    runMigrations(db, dbPath);
    expect(version()).toBe(12);
    // notifications must not be half-migrated either
    expect(colNames("notifications")).not.toContain("project_path");
  });

  it("does NOT bump the version when notifications is missing", () => {
    const dbPath = seedV12({ withNotif: false });
    runMigrations(db, dbPath);
    expect(version()).toBe(12);
    // tdd rows are untouched when the migration does not apply
    const n = db.prepare("SELECT COUNT(*) AS n FROM tdd_cycles").get() as {
      n: number;
    };
    expect(n.n).toBe(3);
  });

  it("does not log on a fresh DB (no pre-existing rows)", () => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
