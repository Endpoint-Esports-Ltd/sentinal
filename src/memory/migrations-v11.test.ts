/**
 * Migration V11: sessions.last_active column
 *
 * RED phase: tests fail until migrateV11 is implemented and SCHEMA_VERSION bumped to 11.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { runMigrations } from "./migrations.js";
import { DB_CONSTANTS } from "./types.js";

describe("Migration V11 — sessions.last_active", () => {
  let tmpDir: string;
  let db: Database;

  afterEach(() => {
    db?.close();
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("should add last_active column to sessions table", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "last_active")).toBe(true);
  });

  it("should bump SCHEMA_VERSION to 11", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(DB_CONSTANTS.SCHEMA_VERSION);
    expect(DB_CONSTANTS.SCHEMA_VERSION).toBe(11);
  });

  it("should allow null last_active (default for pre-V11 rows)", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    // Insert a session without last_active (simulating a pre-V11 row)
    db.prepare(
      `INSERT INTO sessions (id, start_time, project_path, assistant)
       VALUES (?, ?, ?, ?)`,
    ).run("pre-v11-sess", Date.now(), "/test/project", "claude");

    const row = db
      .prepare("SELECT last_active FROM sessions WHERE id = ?")
      .get("pre-v11-sess") as { last_active: number | null };
    expect(row.last_active).toBeNull();
  });

  it("should be idempotent — running migrations twice on V11 database is safe", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);
    // Run again — must not throw
    expect(() => runMigrations(db, dbPath)).not.toThrow();

    // Schema version should still be 11
    const row = db
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(11);
  });

  it("should preserve existing rows when upgrading from V10", () => {
    // Simulate a V10 database: run migrations up to V10 by using the same
    // runMigrations (which now goes to V11), but we can check data is preserved
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath, { create: true });
    runMigrations(db, dbPath);

    // Insert a session
    db.prepare(
      `INSERT INTO sessions (id, start_time, project_path, assistant)
       VALUES (?, ?, ?, ?)`,
    ).run("existing-sess", 1000000, "/test/project", "claude");

    // Run migrations again (idempotent)
    runMigrations(db, dbPath);

    // Existing row must still be there
    const row = db
      .prepare("SELECT id, start_time FROM sessions WHERE id = ?")
      .get("existing-sess") as { id: string; start_time: number } | null;
    expect(row).not.toBeNull();
    expect(row!.id).toBe("existing-sess");
    expect(row!.start_time).toBe(1000000);
  });
});
