/**
 * Migration V15 — `worktrees.owner` + `worktrees.slug` (D1 of the Orca
 * orchestration plan).
 *
 * Driven through the REAL `runMigrations` on connections with
 * `foreign_keys = ON`, like V14's tests: fresh DB, and a DB migrated to
 * exactly V14 that already holds worktree rows.
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { runMigrations } from "./migrations.js";
import {
  migrateV1,
  migrateV2,
  migrateV3,
  migrateV4,
  migrateV5,
  migrateV6,
  migrateV7,
  migrateV8,
  migrateV9,
  migrateV10,
} from "./migrations-legacy.js";
import { migrateV11 } from "./migrations-v11.js";
import { migrateV12 } from "./migrations-v12.js";
import { migrateV13 } from "./migrations-v13.js";
import { migrateV14 } from "./migrations-v14.js";
import { migrateV15 } from "./migrations-v15.js";
import { DB_CONSTANTS } from "./types.js";

let tmpDir = "";
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

function openDb(): { d: Database; dbPath: string } {
  tmpDir = realpathSync(makeTmpDir());
  const dbPath = join(tmpDir, "test.db");
  const d = new Database(dbPath, { create: true });
  d.run("PRAGMA foreign_keys = ON");
  db = d;
  return { d, dbPath };
}

/** A DB migrated to exactly V14 — the shape every user has before V15. */
function v14Db(): { d: Database; dbPath: string } {
  const { d, dbPath } = openDb();
  d.run(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
  );
  migrateV1(d);
  migrateV2(d);
  migrateV3(d);
  migrateV4(d);
  migrateV5(d);
  migrateV6(d);
  migrateV7(d);
  migrateV8(d);
  migrateV9(d);
  migrateV10(d);
  migrateV11(d);
  migrateV12(d);
  migrateV13(d, null);
  migrateV14(d);
  return { d, dbPath };
}

const versions = (d: Database): number[] =>
  (
    d.prepare("SELECT version FROM schema_version ORDER BY version").all() as {
      version: number;
    }[]
  ).map((r) => r.version);

const columns = (
  d: Database,
): Map<string, { dflt: string | null; nn: number }> =>
  new Map(
    (
      d.prepare("PRAGMA table_info(worktrees)").all() as Array<{
        name: string;
        dflt_value: string | null;
        notnull: number;
      }>
    ).map((c) => [c.name, { dflt: c.dflt_value, nn: c.notnull }]),
  );

const slugIndex = (d: Database) =>
  (
    d.prepare("PRAGMA index_list(worktrees)").all() as Array<{
      name: string;
      unique: number;
    }>
  ).find((i) => i.name === "idx_worktrees_project_slug");

function assertV15Shape(d: Database): void {
  const cols = columns(d);
  expect(cols.get("owner")).toEqual({ dflt: "'sentinal'", nn: 1 });
  expect(cols.get("slug")).toEqual({ dflt: null, nn: 0 });
  const idx = slugIndex(d);
  expect(idx).toBeDefined();
  // ⛔ Non-unique: a unique (project_path, slug) could fail unifyLiveKeys'
  // re-key the way idx_wt_slot_live can.
  expect(idx!.unique).toBe(0);
  const idxCols = (
    d.prepare("PRAGMA index_info(idx_worktrees_project_slug)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
  expect(idxCols).toEqual(["project_path", "slug"]);
}

describe("migrateV15 via runMigrations", () => {
  it("SCHEMA_VERSION is 15", () => {
    expect(DB_CONSTANTS.SCHEMA_VERSION).toBe(15);
  });

  it("a fresh DB reaches V15 with owner/slug columns and a non-unique index", () => {
    const { d, dbPath } = openDb();
    runMigrations(d, dbPath);
    assertV15Shape(d);
    expect(versions(d)).toContain(15);
    expect(Math.max(...versions(d))).toBe(DB_CONSTANTS.SCHEMA_VERSION);
  });

  it("a V14 DB with rows reaches V15; existing rows are owner='sentinal', slug NULL; FK + quick_check clean", () => {
    const { d, dbPath } = v14Db();
    expect(versions(d)).not.toContain(15);
    d.run(
      `INSERT INTO worktrees (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, slot)
       VALUES ('w1', NULL, '/p', '/w1', 'sentinal/spec-a', 'main', 'c', 'active', 1, 1),
              ('w2', NULL, '/p', '/w2', 'sentinal/spec-b', 'main', 'c', 'merged', 2, 2)`,
    );

    runMigrations(d, dbPath);

    assertV15Shape(d);
    expect(versions(d)).toContain(15);
    const rows = d
      .prepare("SELECT id, owner, slug, slot FROM worktrees ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "w1", owner: "sentinal", slug: null, slot: 1 },
      { id: "w2", owner: "sentinal", slug: null, slot: 2 },
    ]);
    expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(d.prepare("PRAGMA quick_check").get()).toEqual({
      quick_check: "ok",
    });
  });

  it("new rows default to owner='sentinal' and accept 'external' + a slug", () => {
    const { d, dbPath } = openDb();
    runMigrations(d, dbPath);
    d.run(
      `INSERT INTO worktrees (id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at)
       VALUES ('a', '/p', '/a', 'b1', 'main', 'c', 'active', 1)`,
    );
    d.run(
      `INSERT INTO worktrees (id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, owner, slug)
       VALUES ('b', '/p', '/b', 'b2', 'main', 'c', 'active', 2, 'external', 'phase-1'),
              ('c', '/p', '/c', 'b3', 'main', 'c', 'merged', 3, 'external', 'phase-1')`,
    );
    expect(
      d.prepare("SELECT id, owner, slug FROM worktrees ORDER BY id").all(),
    ).toEqual([
      { id: "a", owner: "sentinal", slug: null },
      { id: "b", owner: "external", slug: "phase-1" },
      { id: "c", owner: "external", slug: "phase-1" },
    ]);
  });

  it("is idempotent — a second run changes nothing and does not throw", () => {
    const { d, dbPath } = openDb();
    runMigrations(d, dbPath);
    expect(() => migrateV15(d)).not.toThrow();
    expect(() => runMigrations(d, dbPath)).not.toThrow();
    assertV15Shape(d);
    expect(versions(d).filter((v) => v === 15)).toEqual([15]);
  });
});

describe("migrateV15 guards", () => {
  it("does NOT record 15 when the worktrees table is missing (retries next start)", () => {
    const { d } = openDb();
    d.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    migrateV15(d);
    expect(versions(d)).toEqual([]);
  });

  it("never throws: a failure rolls back (no columns, no version) and logs", () => {
    const { d } = v14Db();
    // Occupy the index name with a table so CREATE INDEX fails mid-migration.
    d.run("CREATE TABLE idx_worktrees_project_slug (x INTEGER)");
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => migrateV15(d)).not.toThrow();
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0]?.[0])).toContain("V15");
    } finally {
      err.mockRestore();
    }
    expect(versions(d)).not.toContain(15);
    const cols = columns(d);
    expect(cols.has("owner")).toBe(false);
    expect(cols.has("slug")).toBe(false);

    // Once the obstruction is gone, the next start completes it.
    d.run("DROP TABLE idx_worktrees_project_slug");
    migrateV15(d);
    assertV15Shape(d);
    expect(versions(d)).toContain(15);
  });
});
