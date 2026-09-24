/**
 * Retire Routes Tests — POST /retire + requestRetire
 *
 * D3: the route only SETS a flag and returns immediately; the shutdown
 * interval (server.ts) owns the "when safe" decision. The route must be
 * idempotent and must notify (once per installed version) when the client
 * supplies both versions — a client-detected skew must not retire silently.
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
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import * as fileLogModule from "../utils/file-log.js";
import { handleRetireRequest, requestRetire } from "./retire-routes.js";
import { SKEW_NOTIFICATION_SOURCE } from "./retire-notify.js";
import type { SidecarContext } from "./server.js";

function retirePost(body?: unknown): Request {
  return new Request("http://localhost/retire", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function skewNotifications(store: MemoryStore) {
  return store
    .getNotifications({ limit: 100 })
    .filter((n) => n.source === SKEW_NOTIFICATION_SOURCE);
}

describe("handleRetireRequest", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
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
    mock.restore();
  });

  it("returns null for other paths and for non-POST /retire", async () => {
    expect(
      await handleRetireRequest(new Request("http://localhost/health"), ctx),
    ).toBeNull();
    expect(
      await handleRetireRequest(new Request("http://localhost/retire"), ctx),
    ).toBeNull();
    expect(ctx.retire).toBeUndefined();
  });

  it("POST /retire sets the flag and returns ok immediately", async () => {
    const res = await handleRetireRequest(retirePost({}), ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.retiring).toBe(true);
    expect(body.data.alreadyRequested).toBe(false);
    expect(ctx.retire).toBeDefined();
    expect(typeof ctx.retire!.requestedAt).toBe("number");
    expect(ctx.retire!.reason).toContain("client");
  });

  it("tolerates a missing or malformed body", async () => {
    const res = await handleRetireRequest(retirePost(), ctx);
    expect(((await res!.json()) as any).ok).toBe(true);
    expect(ctx.retire).toBeDefined();

    const bad = new Request("http://localhost/retire", {
      method: "POST",
      body: "{not json",
    });
    const res2 = await handleRetireRequest(bad, ctx);
    expect(((await res2!.json()) as any).ok).toBe(true);
  });

  it("is idempotent — repeated POSTs keep the FIRST request", async () => {
    await handleRetireRequest(retirePost({}), ctx);
    const first = ctx.retire!;
    await new Promise((r) => setTimeout(r, 5));
    const res = await handleRetireRequest(retirePost({}), ctx);
    const body = (await res!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.alreadyRequested).toBe(true);
    expect(ctx.retire).toBe(first);
  });

  it("client-triggered retire notifies exactly once when both versions are supplied", async () => {
    for (let i = 0; i < 3; i++) {
      await handleRetireRequest(
        retirePost({ runningVersion: "1.0.0", installedVersion: "1.1.0" }),
        ctx,
      );
    }
    const notes = skewNotifications(store);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("1.0.0");
    expect(notes[0].title).toContain("1.1.0");
  });

  it("does not notify when versions are absent or not strings", async () => {
    await handleRetireRequest(retirePost({}), ctx);
    await handleRetireRequest(
      retirePost({ runningVersion: 1, installedVersion: { x: 1 } }),
      ctx,
    );
    await handleRetireRequest(retirePost({ installedVersion: "1.1.0" }), ctx);
    expect(skewNotifications(store)).toHaveLength(0);
    expect(ctx.retire).toBeDefined();
  });
});

describe("requestRetire", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
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
    mock.restore();
  });

  it("returns true only for the call that set the flag", () => {
    expect(requestRetire(ctx, "binary replaced")).toBe(true);
    expect(requestRetire(ctx, "again")).toBe(false);
    expect(ctx.retire!.reason).toBe("binary replaced");
  });

  it("notifies once even when the flag was already set by another path", () => {
    requestRetire(ctx, "client request");
    requestRetire(ctx, "binary replaced", {
      runningVersion: "2.0.0",
      installedVersion: "2.1.0",
    });
    requestRetire(ctx, "binary replaced", {
      runningVersion: "2.0.0",
      installedVersion: "2.1.0",
    });
    expect(skewNotifications(store)).toHaveLength(1);
  });

  it("never throws when the store is closed", () => {
    store.close();
    expect(() =>
      requestRetire(ctx, "x", {
        runningVersion: "1.0.0",
        installedVersion: "1.0.1",
      }),
    ).not.toThrow();
    // reopen so afterEach close() is harmless
    store = new MemoryStore(join(tmpDir, "test2.db"));
  });
});
