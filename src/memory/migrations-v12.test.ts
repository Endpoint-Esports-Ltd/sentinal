/**
 * Migration V12: worktrees.slot column + partial unique index over the LIVE set.
 *
 * RED phase: fails until migrateV12 exists and SCHEMA_VERSION is bumped to 12.
 *
 * ⛔ The index predicate MUST cover `status IN ('active','ready-to-merge')`.
 * `ready-to-merge` is a LIVE status — the directory still exists and (Phase 4)
 * its process group is still running. Scoping the index to `'active'` alone
 * would free a live worktree's slot and hand it to a second worktree with
 * colliding ports and database names — the exact collision this phase prevents.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { runMigrations } from "./migrations.js";
import { DB_CONSTANTS } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir = "";
let db: Database | undefined;

function freshDb(): Database {
  tmpDir = makeTmpDir();
  const dbPath = join(tmpDir, "test.db");
  db = new Database(dbPath, { create: true });
  runMigrations(db, dbPath);
  return db;
}

let seq = 0;
function insertWt(
  d: Database,
  opts: {
    projectPath?: string;
    status?: string;
    slot?: number | null;
    id?: string;
  } = {},
): void {
  const id = opts.id ?? `wt-${++seq}`;
  d.prepare(
    `INSERT INTO worktrees
       (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, slot)
     VALUES (?, NULL, ?, ?, ?, 'main', 'abc123', ?, ?, ?)`,
  ).run(
    id,
    opts.projectPath ?? "/proj/a",
    `/wt/${id}`,
    `sentinal/spec-${id}`,
    opts.status ?? "active",
    Date.now(),
    opts.slot === undefined ? 1 : opts.slot,
  );
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = "";
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Migration V12 — worktrees.slot", () => {
  it("adds a slot column to the worktrees table", () => {
    const d = freshDb();
    const cols = d.prepare("PRAGMA table_info(worktrees)").all() as Array<{
      name: string;
      type: string;
    }>;
    const slot = cols.find((c) => c.name === "slot");
    expect(slot).toBeDefined();
    expect(slot!.type).toBe("INTEGER");
  });

  it("bumps SCHEMA_VERSION to 12", () => {
    const d = freshDb();
    const row = d
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(DB_CONSTANTS.SCHEMA_VERSION).toBe(12);
    expect(row.version).toBe(12);
  });

  it("is idempotent — re-running runMigrations is a no-op", () => {
    const d = freshDb();
    const dbPath = join(tmpDir, "test.db");
    expect(() => runMigrations(d, dbPath)).not.toThrow();
    expect(() => runMigrations(d, dbPath)).not.toThrow();

    const row = d
      .prepare("SELECT MAX(version) as version FROM schema_version")
      .get() as { version: number };
    expect(row.version).toBe(12);

    const cols = d.prepare("PRAGMA table_info(worktrees)").all() as Array<{
      name: string;
    }>;
    expect(cols.filter((c) => c.name === "slot")).toHaveLength(1);
  });

  it("creates the partial unique index over the live set", () => {
    const d = freshDb();
    const idx = d
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='worktrees' AND sql LIKE '%slot%'",
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(idx).toHaveLength(1);
    const sql = idx[0].sql;
    expect(sql).toContain("UNIQUE");
    expect(sql).toContain("project_path");
    expect(sql).toContain("slot");
    // ⛔ Predicate must cover BOTH live statuses.
    expect(sql).toContain("active");
    expect(sql).toContain("ready-to-merge");
  });

  // ── Uniqueness across the live set ─────────────────────────────────────

  it("rejects two active rows sharing (project_path, slot)", () => {
    const d = freshDb();
    insertWt(d, { status: "active", slot: 1 });
    expect(() => insertWt(d, { status: "active", slot: 1 })).toThrow();
  });

  it("rejects two ready-to-merge rows sharing a slot", () => {
    const d = freshDb();
    insertWt(d, { status: "ready-to-merge", slot: 2 });
    expect(() => insertWt(d, { status: "ready-to-merge", slot: 2 })).toThrow();
  });

  it("rejects one active + one ready-to-merge sharing a slot", () => {
    const d = freshDb();
    insertWt(d, { status: "active", slot: 3 });
    expect(() => insertWt(d, { status: "ready-to-merge", slot: 3 })).toThrow();
  });

  it("rejects an UPDATE that moves a row into the live set onto a taken slot", () => {
    const d = freshDb();
    insertWt(d, { id: "live", status: "active", slot: 4 });
    insertWt(d, { id: "gone", status: "merged", slot: 4 });
    expect(() =>
      d.prepare("UPDATE worktrees SET status = 'active' WHERE id = 'gone'").run(),
    ).toThrow();
  });

  // ── Release is emergent from the predicate ──────────────────────────────

  it("permits the same slot once the other row is terminal (merged)", () => {
    const d = freshDb();
    insertWt(d, { id: "old", status: "merged", slot: 5 });
    expect(() => insertWt(d, { id: "new", status: "active", slot: 5 })).not.toThrow();
  });

  it("permits the same slot once the other row is terminal (abandoned)", () => {
    const d = freshDb();
    insertWt(d, { id: "old", status: "abandoned", slot: 6 });
    expect(() => insertWt(d, { id: "new", status: "active", slot: 6 })).not.toThrow();
  });

  it("frees a slot when a live row transitions to abandoned", () => {
    const d = freshDb();
    insertWt(d, { id: "a", status: "active", slot: 7 });
    expect(() => insertWt(d, { id: "b", status: "active", slot: 7 })).toThrow();
    d.prepare("UPDATE worktrees SET status = 'abandoned' WHERE id = 'a'").run();
    expect(() => insertWt(d, { id: "b", status: "active", slot: 7 })).not.toThrow();
  });

  // ── Scoping ─────────────────────────────────────────────────────────────

  it("scopes uniqueness per project path (D2)", () => {
    const d = freshDb();
    insertWt(d, { projectPath: "/proj/a", status: "active", slot: 1 });
    expect(() =>
      insertWt(d, { projectPath: "/proj/b", status: "active", slot: 1 }),
    ).not.toThrow();
  });

  // ── The property that makes "no backfill" safe ──────────────────────────

  it("permits many live rows with slot = NULL in one project (NULLs are distinct)", () => {
    const d = freshDb();
    expect(() => {
      insertWt(d, { status: "active", slot: null });
      insertWt(d, { status: "active", slot: null });
      insertWt(d, { status: "ready-to-merge", slot: null });
    }).not.toThrow();
    const row = d
      .prepare(
        "SELECT COUNT(*) as c FROM worktrees WHERE slot IS NULL AND project_path = '/proj/a'",
      )
      .get() as { c: number };
    expect(row.c).toBe(3);
  });

  it("defaults pre-V12 rows to slot = NULL", () => {
    const d = freshDb();
    d.prepare(
      `INSERT INTO worktrees
         (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at)
       VALUES ('pre-v12', NULL, '/proj/a', '/wt/pre', 'sentinal/spec-pre', 'main', 'abc', 'active', 1)`,
    ).run();
    const row = d
      .prepare("SELECT slot FROM worktrees WHERE id = 'pre-v12'")
      .get() as { slot: number | null };
    expect(row.slot).toBeNull();
  });

  // ── The V11 guard bug must not be copied ────────────────────────────────

  it("does not record version 12 unless BOTH the slot column and the index exist", () => {
    const d = freshDb();
    const version = (
      d
        .prepare("SELECT MAX(version) as version FROM schema_version")
        .get() as { version: number }
    ).version;

    const hasCol = (
      d.prepare("PRAGMA table_info(worktrees)").all() as Array<{ name: string }>
    ).some((c) => c.name === "slot");
    const hasIdx =
      (
        d
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worktrees' AND sql LIKE '%slot%'",
          )
          .all() as unknown[]
      ).length > 0;

    // If the migration ever bumps to 12 without doing the work, the DB is
    // permanently wedged: the guard skips and the version stops it re-running.
    if (version >= 12) {
      expect(hasCol).toBe(true);
      expect(hasIdx).toBe(true);
    }
    expect(version).toBe(12);
  });

  it("does not bump to 12 when the worktrees table is missing", () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, "partial.db");
    db = new Database(dbPath, { create: true });
    // Simulate a partially-bootstrapped DB: schema_version says 11, but the
    // worktrees table (V5) was never created.
    db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.run("INSERT INTO schema_version (version) VALUES (11)");

    runMigrations(db, dbPath);

    const version = (
      db
        .prepare("SELECT MAX(version) as version FROM schema_version")
        .get() as { version: number }
    ).version;
    expect(version).toBe(11);
  });

  it("preserves existing worktree rows across the upgrade", () => {
    const d = freshDb();
    insertWt(d, { id: "keep", status: "active", slot: null });
    const dbPath = join(tmpDir, "test.db");
    runMigrations(d, dbPath);
    const row = d
      .prepare("SELECT id, branch_name FROM worktrees WHERE id = 'keep'")
      .get() as { id: string; branch_name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.branch_name).toBe("sentinal/spec-keep");
  });
});
