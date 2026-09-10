/**
 * Sidecar Routes Tests — /memory/stats vector enrichment
 *
 * The stats route must include vector availability info from ctx.vectorState
 * and lazily insert a one-time notification when vector search is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
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
