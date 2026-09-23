/**
 * Sidecar Routes Tests — /memory/stats vector enrichment
 *
 * The stats route must include vector availability info from ctx.vectorState
 * and lazily insert a one-time notification when vector search is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SETUP_HINT } from "../memory/native-deps.js";
import type { VectorStore } from "../memory/vector-store.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { handleSidecarRequest } from "./routes.js";
import type { SidecarContext } from "./server.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function getStats(ctx: SidecarContext): Promise<any> {
  const res = await handleSidecarRequest(
    new Request("http://localhost/memory/stats", { method: "GET" }),
    ctx,
  );
  const body = (await res.json()) as { ok: boolean; data: any };
  expect(body.ok).toBe(true);
  return body.data;
}

describe("/memory/stats vector enrichment", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("omits the vector field when ctx.vectorState is absent", async () => {
    const data = await getStats(ctx);
    expect(data.totalObservations).toBe(0);
    expect(data.vector).toBeUndefined();
  });

  it("includes vector info when vector search is ready", async () => {
    ctx.vectorState = {
      status: "ready",
      vectorStore: { getVectorCount: () => 7 } as unknown as VectorStore,
    };
    const data = await getStats(ctx);
    expect(data.vector).toEqual({
      status: "ready",
      count: 7,
      initError: null,
      hint: null,
    });
    // No notification for healthy state
    expect(store.getNotifications().length).toBe(0);
  });

  it("includes error + hint and inserts a one-time notification when unavailable", async () => {
    ctx.vectorState = {
      status: "unavailable",
      error: "sqlite-vec not available",
    };

    const data = await getStats(ctx);
    expect(data.vector).toEqual({
      status: "unavailable",
      count: 0,
      initError: "sqlite-vec not available",
      hint: SETUP_HINT,
    });

    // Notification inserted exactly once, even across repeated stats calls
    await getStats(ctx);
    await getStats(ctx);
    const notifications = store.getNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.title).toBe("Vector search unavailable");
  });

  it("includes initializing status without notification", async () => {
    ctx.vectorState = { status: "initializing" };
    const data = await getStats(ctx);
    expect(data.vector?.status).toBe("initializing");
    expect(store.getNotifications().length).toBe(0);
  });
});

describe("/memory/update and /memory/delete routes", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(content: string): number {
    return ctx.service.addObservation({
      sessionId: "s",
      projectPath: "/p",
      timestamp: Date.now(),
      type: "discovery",
      title: "seed",
      content,
      filePaths: [],
      tags: [],
      metadata: {},
    }).id;
  }

  it("POST /memory/update updates the observation via the service", async () => {
    const id = seed("original");
    const res = await handleSidecarRequest(
      new Request("http://localhost/memory/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content: "corrected" }),
      }),
      ctx,
    );
    const body = (await res!.json()) as { ok: boolean; data: any };
    expect(body.ok).toBe(true);
    expect(body.data.content).toBe("corrected");
    expect(store.getObservation(id)!.content).toBe("corrected");
  });

  it("POST /memory/update returns ok:false / null for a missing id", async () => {
    const res = await handleSidecarRequest(
      new Request("http://localhost/memory/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 999, content: "x" }),
      }),
      ctx,
    );
    const body = (await res!.json()) as { ok: boolean; data: any };
    // Either ok:false or ok:true with null data is acceptable; the row must not exist.
    expect(store.getObservation(999)).toBeNull();
    expect(body.data ?? null).toBeNull();
  });

  it("POST /memory/delete removes the observation via the service", async () => {
    const id = seed("to delete");
    const res = await handleSidecarRequest(
      new Request("http://localhost/memory/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
      ctx,
    );
    const body = (await res!.json()) as { ok: boolean; data: any };
    expect(body.ok).toBe(true);
    expect(store.getObservation(id)).toBeNull();
  });
});

// ─── Project key normalization on the sidecar write paths ─────────────────
//
// Observations and sessions are keyed by projectPath. A linked worktree must
// map to the SAME key as its main checkout, or memory recorded from a worktree
// is invisible from the main checkout (and `isSessionAlive` / the dashboard
// fragment per-worktree).
//
// ⛔ The sidecar's own process.cwd() is MEANINGLESS here — it is a detached,
// long-lived process. These tests deliberately use temp repos that have nothing
// to do with the sidecar's cwd, so a cwd fallback would be visible as a wrong
// answer rather than an accidentally-correct one.

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: dir });
}

async function call(
  ctx: SidecarContext,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const res = await handleSidecarRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  return (await res.json()) as { ok: boolean; data?: any; error?: string };
}

describe("projectPath normalization on /observation and /session", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;
  let mainRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = {
      store,
      service: new MemoryService(store),
      specStore: new SpecStore(store),
      wtStore: new WorktreeStore(store),
    };

    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    worktreePath = join(tmpDir, "wt-feature");
    Bun.spawnSync(
      ["git", "worktree", "add", "-b", "feature", worktreePath, "main"],
      { cwd: repoDir },
    );
    mainRoot = realpathSync(repoDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores an observation posted from a linked worktree under the main checkout key", async () => {
    // Sanity: the fixture really is a distinct linked worktree.
    expect(realpathSync(worktreePath)).not.toBe(mainRoot);

    const r = await call(ctx, "/observation", {
      sessionId: "s-wt",
      projectPath: worktreePath,
      type: "discovery",
      title: "From a worktree",
      content: "recorded while standing in a linked worktree",
    });

    expect(r.ok).toBe(true);
    expect(r.data.projectPath).toBe(mainRoot);
    expect(store.getObservation(r.data.id)!.projectPath).toBe(mainRoot);
  }, 30_000);

  it("stores a session created from a linked worktree under the main checkout key", async () => {
    const r = await call(ctx, "/session", {
      id: "sess-wt",
      projectPath: worktreePath,
      assistant: "opencode",
    });

    expect(r.ok).toBe(true);
    expect(r.data.projectPath).toBe(mainRoot);

    // Querying for the main checkout must find the worktree-born session.
    const active = ctx.store.getActiveSessions();
    expect(active.map((s) => s.projectPath)).toEqual([mainRoot]);
  }, 30_000);

  it('rejects an empty projectPath on /observation instead of storing ""', async () => {
    const r = await call(ctx, "/observation", {
      sessionId: "s-empty",
      projectPath: "",
      type: "discovery",
      title: "No project",
      content: "should not be stored",
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/projectPath/i);
    expect(store.getStats().totalObservations).toBe(0);
  });

  it('rejects a missing projectPath on /observation instead of storing ""', async () => {
    const r = await call(ctx, "/observation", {
      sessionId: "s-missing",
      type: "discovery",
      title: "No project",
      content: "should not be stored",
    });

    expect(r.ok).toBe(false);
    expect(store.getStats().totalObservations).toBe(0);
  });

  it("rejects an empty or missing projectPath on /session", async () => {
    const empty = await call(ctx, "/session", {
      id: "sess-empty",
      projectPath: "   ",
      assistant: "opencode",
    });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/projectPath/i);

    const missing = await call(ctx, "/session", {
      id: "sess-missing",
      assistant: "opencode",
    });
    expect(missing.ok).toBe(false);

    expect(ctx.store.getActiveSessions()).toEqual([]);
  });
});
