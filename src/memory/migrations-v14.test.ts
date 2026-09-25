/**
 * Migration V14 — project-qualified `specs.id` (D6) + the runner (D7).
 *
 * ⛔ `runMigrations` runs OUTSIDE any transaction and every connection has
 * `foreign_keys = ON`. Rewriting a parent key that five tables reference only
 * commits because V14 opens its own transaction and defers FK checks inside it
 * (`defer_foreign_keys` has no effect in autocommit). These tests therefore
 * drive the REAL `runMigrations` on a connection with `foreign_keys = ON`.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
import { DB_CONSTANTS } from "./types.js";

let tmpDir = "";
let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

/** A DB migrated to exactly V13 (the shape every user has before V14). */
function v13Db(): { d: Database; dbPath: string } {
  tmpDir = realpathSync(makeTmpDir());
  const dbPath = join(tmpDir, "test.db");
  const d = new Database(dbPath, { create: true });
  d.run("PRAGMA foreign_keys = ON");
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
  db = d;
  return { d, dbPath };
}

function bareSpec(
  d: Database,
  id: string,
  project: string,
  updatedAt = 1,
  slug = id,
): void {
  d.prepare(
    `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
     VALUES (?, ?, 't', ?, 'feature', 'IN_PROGRESS', '/p.md', 1, ?)`,
  ).run(id, project, slug, updatedAt);
}

const versions = (d: Database): number[] =>
  (
    d.prepare("SELECT version FROM schema_version ORDER BY version").all() as {
      version: number;
    }[]
  ).map((r) => r.version);

describe("migrateV14 via runMigrations", () => {
  it("SCHEMA_VERSION is 14", () => {
    expect(DB_CONSTANTS.SCHEMA_VERSION).toBe(14);
  });

  it("rewrites every spec id to <canonical project>::<slug> and all five child references follow", () => {
    const { d, dbPath } = v13Db();
    const real = join(tmpDir, "repo");
    mkdirSync(real);
    const alias = join(tmpDir, "alias");
    symlinkSync(real, alias);

    bareSpec(d, "alpha", alias);
    bareSpec(d, "beta", "/gone/proj/.sentinal/worktrees/spec-beta");
    d.run(
      `INSERT INTO spec_tasks (spec_id, position, title, status) VALUES ('alpha', 1, 'a1', 'pending'), ('alpha', 2, 'a2', 'pending')`,
    );
    d.run(
      `INSERT INTO spec_events (spec_id, timestamp, event_type, details) VALUES ('alpha', 1, 'phase_change', '{}')`,
    );
    d.run(
      `INSERT INTO tdd_cycles (file_path, spec_id, state, updated_at) VALUES ('/x.ts', 'alpha', 'RED_CONFIRMED', 1)`,
    );
    d.run(
      `INSERT INTO notifications (type, title, spec_id, created_at) VALUES ('warning', 'n', 'beta', 1)`,
    );
    d.run(
      `INSERT INTO worktrees (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at)
       VALUES ('w1', 'alpha', '/p', '/w', 'b', 'main', 'c', 'merged', 1)`,
    );

    runMigrations(d, dbPath);

    const alphaKey = `${real}::alpha`;
    const betaKey = "/gone/proj::beta";
    const specs = d
      .prepare("SELECT id, project_path, slug FROM specs ORDER BY slug")
      .all() as { id: string; project_path: string; slug: string }[];
    expect(specs).toEqual([
      { id: alphaKey, project_path: real, slug: "alpha" },
      { id: betaKey, project_path: "/gone/proj", slug: "beta" },
    ]);
    const ref = (table: string) =>
      (
        d.prepare(`SELECT DISTINCT spec_id FROM ${table}`).all() as {
          spec_id: string;
        }[]
      ).map((r) => r.spec_id);
    expect(ref("spec_tasks")).toEqual([alphaKey]);
    expect(ref("spec_events")).toEqual([alphaKey]);
    expect(ref("tdd_cycles")).toEqual([alphaKey]);
    expect(ref("notifications")).toEqual([betaKey]);
    expect(ref("worktrees")).toEqual([alphaKey]);

    expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (d.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);
    expect(versions(d)).toContain(14);
  });

  it("resolves a key collision deterministically: newest row wins, loser's tasks/events deleted, nullable refs re-pointed", () => {
    const { d, dbPath } = v13Db();
    bareSpec(d, "gamma", "/p", 200);
    bareSpec(
      d,
      "gamma-legacy",
      "/p/.sentinal/worktrees/spec-gamma",
      100,
      "gamma",
    );
    d.run(
      `INSERT INTO spec_tasks (spec_id, position, title, status) VALUES
         ('gamma', 1, 'winner', 'pending'), ('gamma-legacy', 1, 'loser', 'pending')`,
    );
    d.run(
      `INSERT INTO spec_events (spec_id, timestamp, event_type, details) VALUES ('gamma-legacy', 1, 'x', '{}')`,
    );
    d.run(
      `INSERT INTO tdd_cycles (file_path, spec_id, state, updated_at) VALUES ('/l.ts', 'gamma-legacy', 'IDLE', 1)`,
    );

    runMigrations(d, dbPath);

    expect(d.prepare("SELECT id FROM specs").all() as { id: string }[]).toEqual(
      [{ id: "/p::gamma" }],
    );
    expect(d.prepare("SELECT spec_id, title FROM spec_tasks").all()).toEqual([
      { spec_id: "/p::gamma", title: "winner" },
    ]);
    expect(
      (
        d.prepare("SELECT COUNT(*) AS n FROM spec_events").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      d.prepare("SELECT spec_id FROM tdd_cycles").get() as { spec_id: string },
    ).toEqual({ spec_id: "/p::gamma" });
    expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("an OLD bare-id writer after V14 fails loudly on the (project_path, slug) unique index", () => {
    const { d, dbPath } = v13Db();
    bareSpec(d, "delta", "/q");
    runMigrations(d, dbPath);
    expect(() => bareSpec(d, "delta", "/q")).toThrow(/UNIQUE/);
  });

  it("is idempotent: a second run changes nothing", () => {
    const { d, dbPath } = v13Db();
    bareSpec(d, "eps", "/r");
    runMigrations(d, dbPath);
    const before = d.prepare("SELECT * FROM specs").all();
    runMigrations(d, dbPath);
    expect(d.prepare("SELECT * FROM specs").all()).toEqual(before);
  });
});

describe("runMigrations — runs every unrecorded step (D7)", () => {
  it("runs a missing MIDDLE step even when a later version is recorded", () => {
    tmpDir = realpathSync(makeTmpDir());
    const dbPath = join(tmpDir, "test.db");
    const d = new Database(dbPath, { create: true });
    db = d;
    d.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
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
    // V13 skipped (e.g. its guard declined), but a later step recorded itself.
    d.run("INSERT INTO schema_version (version) VALUES (14)");

    runMigrations(d, dbPath);

    const cols = (
      d.prepare("PRAGMA table_info(tdd_cycles)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("project_path");
    expect(versions(d)).toContain(13);
  });

  it("V11 records itself only when its column actually exists", () => {
    tmpDir = realpathSync(makeTmpDir());
    const dbPath = join(tmpDir, "test.db");
    const d = new Database(dbPath, { create: true });
    db = d;
    d.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    migrateV11(d); // no sessions table → nothing to verify
    expect(versions(d)).not.toContain(11);
  });
});
