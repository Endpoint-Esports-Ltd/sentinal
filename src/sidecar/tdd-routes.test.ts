/**
 * TDD Routes Tests
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { makeTmpDir } from "../test-helpers.js";
import * as fileLogModule from "../utils/file-log.js";
import { SIDECAR_LOG_FILE, readLastLines } from "../utils/file-log.js";
import type { SidecarContext } from "./server.js";
import {
  bulkTddTransition,
  handleTddTransitionRequest,
  MISSING_TRANSITION_PROJECT_LOG,
} from "./tdd-routes.js";

const PROJECT_A = "/proj-a";
const PROJECT_B = "/proj-b";

function ensureSpec(store: MemoryStore, specId: string): void {
  const db = store.getRawDb();
  db.run(
    `INSERT OR IGNORE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at)
     VALUES (?, '/test', 'Test', ?, 'feature', 'IN_PROGRESS', 1, '/test.md', 1, 0, ?, ?)`,
    [specId, specId, Date.now(), Date.now()],
  );
}

/** Seed one TEST_WRITTEN and one RED_CONFIRMED row in each of A and B. */
function seedTwoProjects(store: MemoryStore): void {
  for (const [project, tag] of [
    [PROJECT_A, "a"],
    [PROJECT_B, "b"],
  ] as const) {
    store.setTddState({
      filePath: `${project}/src/${tag}-written.ts`,
      state: "TEST_WRITTEN",
      projectPath: project,
    });
    store.setTddState({
      filePath: `${project}/src/${tag}-red.ts`,
      state: "RED_CONFIRMED",
      projectPath: project,
    });
  }
}

describe("bulkTddTransition", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    ensureSpec(store, "spec-1");
    ensureSpec(store, "spec-2");
  });

  afterEach(() => {
    store.close();
  });

  it("should transition TEST_WRITTEN to RED_CONFIRMED on confirm_red", () => {
    store.setTddState({
      filePath: "src/a.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
      testFilePath: "src/a.test.ts",
      projectPath: PROJECT_A,
    });
    store.setTddState({
      filePath: "src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
      testFilePath: "src/b.test.ts",
      projectPath: PROJECT_A,
    });

    const result = bulkTddTransition(store, "confirm_red", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(2);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
    expect(b!.state).toBe("RED_CONFIRMED");
  });

  it("should not transition RED_CONFIRMED states on confirm_red", () => {
    store.setTddState({
      filePath: "src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-1",
      projectPath: PROJECT_A,
    });
    store.setTddState({
      filePath: "src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
      projectPath: PROJECT_A,
    });

    const result = bulkTddTransition(store, "confirm_red", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(1); // only b.ts

    const a = store.getTddState("src/a.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
  });

  it("should clear RED_CONFIRMED states on confirm_green", () => {
    store.setTddState({
      filePath: "src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-1",
      projectPath: PROJECT_A,
    });
    store.setTddState({
      filePath: "src/b.ts",
      state: "RED_CONFIRMED",
      specId: "spec-1",
      projectPath: PROJECT_A,
    });
    store.setTddState({
      filePath: "src/c.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
      projectPath: PROJECT_A,
    }); // should NOT be cleared

    const result = bulkTddTransition(store, "confirm_green", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(2);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    const c = store.getTddState("src/c.ts");
    expect(a).toBeNull(); // cleared
    expect(b).toBeNull(); // cleared
    expect(c!.state).toBe("TEST_WRITTEN"); // untouched
  });

  it("should return 0 when no matching states exist", () => {
    const result = bulkTddTransition(store, "confirm_red", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(0);
  });

  it("should scope to specId when provided", () => {
    store.setTddState({
      filePath: "src/a.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
      projectPath: PROJECT_A,
    });
    store.setTddState({
      filePath: "src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-2",
      projectPath: PROJECT_A,
    });

    const result = bulkTddTransition(store, "confirm_red", {
      projectPath: PROJECT_A,
      specId: "spec-1",
    });
    expect(result.count).toBe(1);

    const a = store.getTddState("src/a.ts");
    const b = store.getTddState("src/b.ts");
    expect(a!.state).toBe("RED_CONFIRMED");
    expect(b!.state).toBe("TEST_WRITTEN"); // different spec, untouched
  });

  // ─── Project isolation (D6: destructive writes fail CLOSED) ────────────────

  it("confirm_red scoped to project A leaves project B's rows untouched", () => {
    seedTwoProjects(store);

    const result = bulkTddTransition(store, "confirm_red", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(1);

    expect(store.getTddState(`${PROJECT_A}/src/a-written.ts`)!.state).toBe(
      "RED_CONFIRMED",
    );
    // B untouched — both rows keep their exact state
    expect(store.getTddState(`${PROJECT_B}/src/b-written.ts`)!.state).toBe(
      "TEST_WRITTEN",
    );
    expect(store.getTddState(`${PROJECT_B}/src/b-red.ts`)!.state).toBe(
      "RED_CONFIRMED",
    );
  });

  it("confirm_green scoped to project A does NOT delete project B's RED rows", () => {
    seedTwoProjects(store);

    const result = bulkTddTransition(store, "confirm_green", {
      projectPath: PROJECT_A,
    });
    expect(result.count).toBe(1);

    expect(store.getTddState(`${PROJECT_A}/src/a-red.ts`)).toBeNull();
    expect(store.getTddState(`${PROJECT_A}/src/a-written.ts`)!.state).toBe(
      "TEST_WRITTEN",
    );
    // B's RED row — the one the old unscoped DELETE destroyed — survives
    expect(store.getTddState(`${PROJECT_B}/src/b-red.ts`)!.state).toBe(
      "RED_CONFIRMED",
    );
    expect(store.getTddState(`${PROJECT_B}/src/b-written.ts`)!.state).toBe(
      "TEST_WRITTEN",
    );
  });

  it("does not touch NULL-project rows (pre-scoping writers)", () => {
    store.setTddState({ filePath: "/legacy/red.ts", state: "RED_CONFIRMED" });
    store.setTddState({ filePath: "/legacy/tw.ts", state: "TEST_WRITTEN" });

    expect(
      bulkTddTransition(store, "confirm_green", { projectPath: PROJECT_A })
        .count,
    ).toBe(0);
    expect(
      bulkTddTransition(store, "confirm_red", { projectPath: PROJECT_A }).count,
    ).toBe(0);
    expect(store.getTddState("/legacy/red.ts")!.state).toBe("RED_CONFIRMED");
    expect(store.getTddState("/legacy/tw.ts")!.state).toBe("TEST_WRITTEN");
  });

  it("throws on a blank projectPath rather than sweeping every project", () => {
    seedTwoProjects(store);
    expect(() =>
      bulkTddTransition(store, "confirm_green", { projectPath: "" }),
    ).toThrow(/project/i);
    expect(() =>
      bulkTddTransition(store, "confirm_red", { projectPath: "   " }),
    ).toThrow(/project/i);
    // nothing touched
    expect(store.getTddState(`${PROJECT_A}/src/a-red.ts`)).not.toBeNull();
    expect(store.getTddState(`${PROJECT_B}/src/b-red.ts`)).not.toBeNull();
  });
});

// ─── Route handler ───────────────────────────────────────────────────────────

describe("handleTddTransitionRequest", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  const logLines = (): string[] =>
    readLastLines(join(tmpDir, SIDECAR_LOG_FILE), 100);

  const request = (body: unknown): Request =>
    new Request("http://localhost/tdd-state/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    tmpDir = makeTmpDir("tdd-routes");
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = { store } as unknown as SidecarContext;
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("returns null for a non-matching path", async () => {
    const res = await handleTddTransitionRequest(
      new Request("http://localhost/other", { method: "POST", body: "{}" }),
      ctx,
    );
    expect(res).toBeNull();
  });

  for (const action of ["confirm_red", "confirm_green"] as const) {
    it(`${action}: a scoped request leaves project B untouched`, async () => {
      seedTwoProjects(store);
      const res = await handleTddTransitionRequest(
        request({ action, projectPath: PROJECT_A }),
        ctx,
      );
      expect(res!.status).toBe(200);
      const json = (await res!.json()) as {
        ok: boolean;
        data: { count: number };
      };
      expect(json.data.count).toBe(1);
      expect(store.getTddState(`${PROJECT_B}/src/b-red.ts`)!.state).toBe(
        "RED_CONFIRMED",
      );
      expect(store.getTddState(`${PROJECT_B}/src/b-written.ts`)!.state).toBe(
        "TEST_WRITTEN",
      );
    });

    for (const [label, body] of [
      ["missing", { action }],
      ["empty", { action, projectPath: "" }],
      ["blank", { action, projectPath: "   " }],
      ["non-string", { action, projectPath: 42 }],
    ] as const) {
      it(`${action}: ${label} projectPath → 400, nothing swept, distinct log`, async () => {
        seedTwoProjects(store);
        const res = await handleTddTransitionRequest(request(body), ctx);
        expect(res!.status).toBe(400);
        const json = (await res!.json()) as { ok: boolean; error: string };
        expect(json.ok).toBe(false);
        expect(json.error).toMatch(/projectPath/);

        // Fail CLOSED: every row in both projects survives unchanged
        expect(store.getTddState(`${PROJECT_A}/src/a-red.ts`)!.state).toBe(
          "RED_CONFIRMED",
        );
        expect(store.getTddState(`${PROJECT_A}/src/a-written.ts`)!.state).toBe(
          "TEST_WRITTEN",
        );
        expect(store.getTddState(`${PROJECT_B}/src/b-red.ts`)!.state).toBe(
          "RED_CONFIRMED",
        );

        const lines = logLines().filter((l) =>
          l.includes(MISSING_TRANSITION_PROJECT_LOG),
        );
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain(action);
      });
    }
  }

  it("normalizes the project at the boundary (trailing slash matches)", async () => {
    seedTwoProjects(store);
    const res = await handleTddTransitionRequest(
      request({ action: "confirm_green", projectPath: `${PROJECT_A}/` }),
      ctx,
    );
    const json = (await res!.json()) as { data: { count: number } };
    expect(json.data.count).toBe(1);
    expect(store.getTddState(`${PROJECT_A}/src/a-red.ts`)).toBeNull();
  });

  it("an invalid action is still a 400 and does not emit the project log", async () => {
    const res = await handleTddTransitionRequest(
      request({ action: "nope", projectPath: PROJECT_A }),
      ctx,
    );
    expect(res!.status).toBe(400);
    expect(
      logLines().some((l) => l.includes(MISSING_TRANSITION_PROJECT_LOG)),
    ).toBe(false);
  });
});

// ─── Task 10: canonical keys on get/list; D4 inferred project on set ─────────

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { handleTddStateRoute } from "./tdd-routes.js";
import { writeFileSync } from "node:fs";

describe("per-file TDD routes — project canonicalization (D3/D4)", () => {
  let root: string;
  let aliasHolder: string;
  let alias: string;
  let logDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  async function call(
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; data?: any; error?: string; status: number }> {
    const req = new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = (await handleTddStateRoute(new URL(req.url), req, ctx))!;
    return { ...((await res.json()) as any), status: res.status };
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tdd-rt-canon-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, "src"));
    aliasHolder = realpathSync(mkdtempSync(join(tmpdir(), "tdd-rt-alias-")));
    symlinkSync(root, join(aliasHolder, "link"));
    alias = join(aliasHolder, "link", "src");
    logDir = makeTmpDir("tdd-rt-log");
    spyOn(fileLogModule, "getLogDir").mockReturnValue(logDir);
    store = new MemoryStore(":memory:");
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
  });

  afterEach(() => {
    mock.restore();
    store.close();
    for (const d of [root, aliasHolder, logDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("GET /tdd-state canonicalizes the project used for hasActiveSpec", async () => {
    const plans = join(root, "docs", "plans");
    mkdirSync(plans, { recursive: true });
    const plan = join(plans, "2026-09-25-tdd-get.md");
    writeFileSync(plan, "# P\n\nStatus: IN_PROGRESS\nType: Feature\n");
    ctx.specStore.syncFromPlanFile(plan, root);
    const r = await call(
      `/tdd-state?file=${encodeURIComponent(join(root, "src/a.ts"))}&project=${encodeURIComponent(alias)}`,
    );
    expect(r.data).toEqual({ state: "IDLE", hasActiveSpec: true });
  }, 30_000);

  it("GET /tdd-state/list scopes to a supplied (canonicalized) project; absent = all", async () => {
    store.setTddState({
      filePath: join(root, "src/mine.ts"),
      state: "RED_CONFIRMED",
      projectPath: root,
    });
    store.setTddState({
      filePath: "/elsewhere/src/other.ts",
      state: "RED_CONFIRMED",
      projectPath: "/elsewhere",
    });
    const scoped = await call(
      `/tdd-state/list?project=${encodeURIComponent(alias)}`,
    );
    expect(scoped.data.map((c: any) => c.filePath)).toEqual([
      join(root, "src/mine.ts"),
    ]);
    const all = await call("/tdd-state/list");
    expect(all.data).toHaveLength(2);
    const blank = await call("/tdd-state/list?project=%20");
    expect(blank.data).toHaveLength(2);
  }, 30_000);

  it("POST set WITHOUT a project stores the project inferred from the file (D4)", async () => {
    // `src/new/` does not exist: inference climbs to the nearest existing dir.
    const file = join(alias, "new", "thing.ts");
    const r = await call("/tdd-state", {
      action: "set",
      filePath: file,
      state: "TEST_WRITTEN",
    });
    expect(r.ok).toBe(true);
    expect(store.getTddState(file)!.projectPath).toBe(root);
    const log = readLastLines(join(logDir, SIDECAR_LOG_FILE), 20).join("\n");
    expect(log).toContain("inferred projectPath");
  }, 30_000);

  it("POST set WITHOUT a project and with a RELATIVE filePath is a 400", async () => {
    const r = await call("/tdd-state", {
      action: "set",
      filePath: "src/relative.ts",
      state: "TEST_WRITTEN",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(store.getTddState("src/relative.ts")).toBeNull();
  });
});
