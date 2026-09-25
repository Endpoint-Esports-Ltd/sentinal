/**
 * Project-qualified spec rows (D6) through the stores.
 *
 * `specs.id` = `<canonicalProject>::<slug>`; the API keeps `Spec.id` = slug and
 * adds `key` + `projectPath`. Every store method that takes a spec id accepts
 * EITHER the key or the slug and resolves it at the boundary, so a caller that
 * still holds the slug (an old plugin, an agent's `spec_id`) writes the key.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";

const PLAN = `# Same Name Plan

Status: IN_PROGRESS
Type: Feature

## Progress Tracking

- [ ] Task 1: First
- [ ] Task 2: Second
`;
const SLUG = "2026-01-01-add-auth";

function writePlan(dir: string, name = `${SLUG}.md`): string {
  const plans = join(dir, "docs", "plans");
  mkdirSync(plans, { recursive: true });
  const f = join(plans, name);
  writeFileSync(f, PLAN);
  return f;
}

describe("SpecStore — same plan filename in two projects", () => {
  let tmp: string;
  let memoryStore: MemoryStore;
  let specStore: SpecStore;
  let planA: string;
  let planB: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-keys-")));
    memoryStore = new MemoryStore(":memory:");
    specStore = new SpecStore(memoryStore);
    planA = writePlan(join(tmp, "a"));
    planB = writePlan(join(tmp, "b"));
    specStore.syncFromPlanFile(planA, "/test/a");
    specStore.syncFromPlanFile(planB, "/test/b");
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps two rows, one per project", () => {
    const rows = memoryStore
      .getRawDb()
      .prepare("SELECT id, project_path FROM specs ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: `/test/a::${SLUG}`, project_path: "/test/a" },
      { id: `/test/b::${SLUG}`, project_path: "/test/b" },
    ]);
  });

  it("returns Spec.id = slug plus key and projectPath", () => {
    const a = specStore.getCurrentSpec("/test/a")!;
    expect(a.id).toBe(SLUG);
    expect(a.key).toBe(`/test/a::${SLUG}`);
    expect(a.projectPath).toBe("/test/a");
    expect(a.planFile).toBe(planA);
    expect(specStore.getCurrentSpec("/test/b")!.planFile).toBe(planB);
  });

  it("getSpec resolves key, (slug, project), and refuses an ambiguous bare slug", () => {
    expect(specStore.getSpec(`/test/b::${SLUG}`)!.planFile).toBe(planB);
    expect(specStore.getSpec(SLUG, "/test/a")!.planFile).toBe(planA);
    expect(specStore.getSpec(SLUG)).toBeNull();
  });

  it("tasks are per project and getCurrentTask accepts the key or (slug, project)", () => {
    specStore.updateTaskStatus(`/test/a::${SLUG}`, 1, "complete");
    expect(specStore.getCurrentTask(`/test/a::${SLUG}`)!.position).toBe(2);
    expect(specStore.getCurrentTask(SLUG, "/test/b")!.position).toBe(1);
  });

  it("isSlugInProgress fails SAFE: any project's same-named IN_PROGRESS plan counts (destructive-cleanup guard)", () => {
    expect(specStore.isSlugInProgress(SLUG)).toBe(true);
    memoryStore
      .getRawDb()
      .prepare(
        "UPDATE specs SET status = 'VERIFIED' WHERE project_path = '/test/a'",
      )
      .run();
    expect(specStore.isSlugInProgress(SLUG)).toBe(true); // /test/b still running
    memoryStore
      .getRawDb()
      .prepare("UPDATE specs SET status = 'VERIFIED'")
      .run();
    expect(specStore.isSlugInProgress(SLUG)).toBe(false);
    expect(specStore.isSlugInProgress("unknown")).toBe(false);
  });

  it("re-syncing one project never touches the other's row", () => {
    specStore.syncFromPlanFile(planA, "/test/a");
    expect(specStore.listSpecs("/test/b")).toHaveLength(1);
    expect(specStore.listSpecs("/test/a")).toHaveLength(1);
  });
});

describe("FK writers resolve a slug to the key at the store boundary", () => {
  let tmp: string;
  let memoryStore: MemoryStore;
  let specStore: SpecStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-fk-")));
    memoryStore = new MemoryStore(":memory:");
    specStore = new SpecStore(memoryStore);
    specStore.syncFromPlanFile(writePlan(join(tmp, "a")), "/test/a");
    specStore.syncFromPlanFile(
      writePlan(join(tmp, "a"), "2026-01-02-unique.md"),
      "/test/a",
    );
    specStore.syncFromPlanFile(writePlan(join(tmp, "b")), "/test/b");
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const col = (table: string, where: string, arg: string | number) =>
    (
      memoryStore
        .getRawDb()
        .prepare(`SELECT spec_id FROM ${table} WHERE ${where} = ?`)
        .get(arg) as { spec_id: string | null } | null
    )?.spec_id;

  it("TDD cycle: slug + project → key", () => {
    memoryStore.setTddState({
      filePath: "/test/b/src/x.ts",
      specId: SLUG,
      state: "RED_CONFIRMED",
      projectPath: "/test/b",
    });
    expect(col("tdd_cycles", "file_path", "/test/b/src/x.ts")).toBe(
      `/test/b::${SLUG}`,
    );
  });

  it("spec event: unique slug → key", () => {
    memoryStore.logSpecEvent({
      specId: "2026-01-02-unique",
      eventType: "task_update",
      details: {},
    });
    expect(col("spec_events", "event_type", "task_update")).toBe(
      "/test/a::2026-01-02-unique",
    );
  });

  it("spec event: slug + project → key", () => {
    memoryStore.logSpecEvent({
      specId: SLUG,
      projectPath: "/test/b",
      eventType: "tdd_cycle",
      details: {},
    });
    expect(col("spec_events", "event_type", "tdd_cycle")).toBe(
      `/test/b::${SLUG}`,
    );
  });

  it("notification: unique slug → key; ambiguous slug → NULL (never a guess, never a throw)", () => {
    const n1 = memoryStore.insertNotification({
      type: "warning",
      title: "u",
      specId: "2026-01-02-unique",
    });
    const n2 = memoryStore.insertNotification({
      type: "warning",
      title: "amb",
      specId: SLUG,
    });
    expect(col("notifications", "id", n1.id)).toBe(
      "/test/a::2026-01-02-unique",
    );
    expect(col("notifications", "id", n2.id)).toBeNull();
  });

  it("clearTddStatesForSpec / listActiveTddStates accept the slug", () => {
    memoryStore.setTddState({
      filePath: "/test/b/src/y.ts",
      specId: SLUG,
      state: "RED_CONFIRMED",
      projectPath: "/test/b",
    });
    expect(memoryStore.listActiveTddStates(SLUG, "/test/b")).toHaveLength(1);
    memoryStore.clearTddStatesForSpec(`/test/b::${SLUG}`);
    expect(memoryStore.listActiveTddStates(SLUG, "/test/b")).toHaveLength(0);
  });

  it("getSpecEvents accepts the unique slug", () => {
    memoryStore.logSpecEvent({
      specId: "2026-01-02-unique",
      eventType: "note",
      details: {},
    });
    expect(memoryStore.getSpecEvents("2026-01-02-unique")).toHaveLength(1);
  });
});

describe("runtime heal: a same-identity row under another key is re-keyed, not duplicated", () => {
  let main: string;
  let linkedParent: string;
  let linked: string;
  let memoryStore: MemoryStore;
  let specStore: SpecStore;
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });

  beforeEach(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "heal-main-")));
    git(main, "init", "-q", "-b", "main");
    git(
      main,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    linkedParent = realpathSync(mkdtempSync(join(tmpdir(), "heal-linked-")));
    linked = join(linkedParent, "wt");
    git(main, "worktree", "add", "-q", linked, "-b", "f");
    memoryStore = new MemoryStore(":memory:");
    specStore = new SpecStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    git(main, "worktree", "remove", "--force", linked);
    rmSync(main, { recursive: true, force: true });
    rmSync(linkedParent, { recursive: true, force: true });
  });

  function plantRow(id: string, project: string): void {
    const db = memoryStore.getRawDb();
    db.prepare(
      `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
       VALUES (?, ?, 't', ?, 'feature', 'IN_PROGRESS', '/p.md', 1, 1)`,
    ).run(id, project, SLUG);
    db.prepare(
      `INSERT INTO spec_tasks (spec_id, position, title, status) VALUES (?, 1, 'old', 'pending')`,
    ).run(id);
    db.prepare(
      `INSERT INTO tdd_cycles (file_path, spec_id, state, updated_at) VALUES ('/h.ts', ?, 'RED_CONFIRMED', 1)`,
    ).run(id);
  }

  for (const [label, idOf] of [
    ["a linked-worktree key", (l: string) => `${l}::${SLUG}`],
    ["a bare pre-V14 id written by an old sidecar", () => SLUG],
  ] as const) {
    it(`heals ${label}`, () => {
      plantRow(idOf(linked), linked);
      specStore.syncFromPlanFile(writePlan(main), main);

      const db = memoryStore.getRawDb();
      expect(db.prepare("SELECT id FROM specs").all()).toEqual([
        { id: `${main}::${SLUG}` },
      ]);
      expect(
        (
          db.prepare("SELECT spec_id FROM tdd_cycles").get() as {
            spec_id: string;
          }
        ).spec_id,
      ).toBe(`${main}::${SLUG}`);
      expect(specStore.getTasksForSpec(`${main}::${SLUG}`)).toHaveLength(2);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }, 30_000);
  }

  it("does NOT re-key a same-slug row of a DIFFERENT project", () => {
    plantRow(`/other/project::${SLUG}`, "/other/project");
    specStore.syncFromPlanFile(writePlan(main), main);
    expect(
      memoryStore.getRawDb().prepare("SELECT COUNT(*) AS n FROM specs").get(),
    ).toEqual({ n: 2 });
  }, 30_000);
});
