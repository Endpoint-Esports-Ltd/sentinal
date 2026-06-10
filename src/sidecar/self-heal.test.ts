/**
 * Sidecar Vector Self-Heal Tests
 *
 * maybeSelfHealVectorDeps: a vector-degraded sidecar with missing native deps
 * provisions itself by spawning its own binary's `memory setup`, then
 * re-initializes via an injected reinit callback. Gated on: missing-deps
 * degrade reason, env opt-out, version-scoped settings backoff (written at
 * attempt START), and running as a compiled binary.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SETUP_HINT } from "../memory/native-deps.js";
import type { MemoryService } from "../memory/service.js";
import type { SidecarContext } from "./server.js";
import { initVectorSearch } from "./vector-init.js";
import {
  maybeSelfHealVectorDeps,
  VECTOR_AUTOSETUP_ATTEMPTED_KEY,
  type SelfHealContext,
} from "./self-heal.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-self-heal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MISSING_DEPS_ERROR = `sqlite-vec not available. ${SETUP_HINT}`;

describe("maybeSelfHealVectorDeps", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let savedEnv: string | undefined;

  function makeCtx(error: string = MISSING_DEPS_ERROR): SelfHealContext {
    return {
      store,
      vectorState: { status: "unavailable", error },
    };
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    savedEnv = process.env.SENTINAL_NO_AUTO_SETUP;
    delete process.env.SENTINAL_NO_AUTO_SETUP;
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedEnv === undefined) {
      delete process.env.SENTINAL_NO_AUTO_SETUP;
    } else {
      process.env.SENTINAL_NO_AUTO_SETUP = savedEnv;
    }
  });

  it("spawns its own binary's `memory setup` on missing-deps degrade", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ctx = makeCtx();
    const attempted = await maybeSelfHealVectorDeps(ctx, {
      forceCompiled: true,
      spawner: async (cmd, args) => {
        calls.push({ cmd, args });
        return 0;
      },
      reinit: async () => {},
    });

    expect(attempted).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual(["memory", "setup"]);
  });

  it("backoff key prevents a second attempt", async () => {
    let spawnCount = 0;
    const opts = {
      forceCompiled: true,
      spawner: async () => {
        spawnCount++;
        return 0;
      },
      reinit: async () => {},
    };

    const first = await maybeSelfHealVectorDeps(makeCtx(), opts);
    const second = await maybeSelfHealVectorDeps(makeCtx(), opts);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(spawnCount).toBe(1);
  });

  it("writes the backoff key at attempt START even when spawn throws", async () => {
    const ctx = makeCtx();
    const attempted = await maybeSelfHealVectorDeps(ctx, {
      forceCompiled: true,
      spawner: async () => {
        throw new Error("spawn ENOENT");
      },
    });

    expect(attempted).toBe(true);
    expect(store.getSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY)).not.toBeNull();
    // honest failure: no success notification
    expect(store.getNotifications().length).toBe(0);
  });

  it("respects SENTINAL_NO_AUTO_SETUP=1 opt-out", async () => {
    process.env.SENTINAL_NO_AUTO_SETUP = "1";
    let spawned = false;
    const attempted = await maybeSelfHealVectorDeps(makeCtx(), {
      forceCompiled: true,
      spawner: async () => {
        spawned = true;
        return 0;
      },
    });

    expect(attempted).toBe(false);
    expect(spawned).toBe(false);
    expect(store.getSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY)).toBeNull();
  });

  it("does NOT trigger on extension-load failures setup cannot fix", async () => {
    let spawned = false;
    const opts = {
      forceCompiled: true,
      spawner: async () => {
        spawned = true;
        return 0;
      },
    };

    const a = await maybeSelfHealVectorDeps(
      makeCtx("SQLITE_ERROR: not authorized"),
      opts,
    );
    const b = await maybeSelfHealVectorDeps(
      makeCtx("loadExtension failed: dlopen error"),
      opts,
    );

    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(spawned).toBe(false);
    expect(store.getSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY)).toBeNull();
  });

  it("does NOT trigger when the state is not unavailable", async () => {
    let spawned = false;
    const ctx: SelfHealContext = { store, vectorState: { status: "ready" } };
    const attempted = await maybeSelfHealVectorDeps(ctx, {
      forceCompiled: true,
      spawner: async () => {
        spawned = true;
        return 0;
      },
    });

    expect(attempted).toBe(false);
    expect(spawned).toBe(false);
  });

  it("does NOT trigger on source runs (no compiled-binary define)", async () => {
    // Tests run from source: typeof __SENTINAL_VERSION__ === "undefined",
    // so without forceCompiled the self-heal must naturally skip.
    let spawned = false;
    const attempted = await maybeSelfHealVectorDeps(makeCtx(), {
      spawner: async () => {
        spawned = true;
        return 0;
      },
    });

    expect(attempted).toBe(false);
    expect(spawned).toBe(false);
    expect(store.getSetting(VECTOR_AUTOSETUP_ATTEMPTED_KEY)).toBeNull();
  });

  it("success path: setup exit 0 → reinit called → info notification inserted", async () => {
    const ctx = makeCtx();
    let reinitCalled = false;
    const attempted = await maybeSelfHealVectorDeps(ctx, {
      forceCompiled: true,
      spawner: async () => 0,
      reinit: async () => {
        reinitCalled = true;
        ctx.vectorState = { status: "ready" };
      },
    });

    expect(attempted).toBe(true);
    expect(reinitCalled).toBe(true);
    const notifications = store.getNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.type).toBe("info");
    expect(notifications[0]!.title).toBe("Semantic search enabled");
    expect(notifications[0]!.source).toBe("self-heal");
  });

  it("failed setup (non-zero exit): no reinit, no notification", async () => {
    let reinitCalled = false;
    const attempted = await maybeSelfHealVectorDeps(makeCtx(), {
      forceCompiled: true,
      spawner: async () => 1,
      reinit: async () => {
        reinitCalled = true;
      },
    });

    expect(attempted).toBe(true);
    expect(reinitCalled).toBe(false);
    expect(store.getNotifications().length).toBe(0);
  });

  it("re-init still degraded: no success notification", async () => {
    const ctx = makeCtx();
    const attempted = await maybeSelfHealVectorDeps(ctx, {
      forceCompiled: true,
      spawner: async () => 0,
      reinit: async () => {
        ctx.vectorState = {
          status: "unavailable",
          error: MISSING_DEPS_ERROR,
        };
      },
    });

    expect(attempted).toBe(true);
    expect(store.getNotifications().length).toBe(0);
  });
});

describe("initVectorSearch self-heal wiring", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSidecarCtx(): SidecarContext {
    return {
      store,
      service: {} as MemoryService,
    } as unknown as SidecarContext;
  }

  it("fires the self-heal hook after a missing-deps degrade", async () => {
    const ctx = makeSidecarCtx();
    const selfHealCalls: Array<{
      status: string | undefined;
      hasReinit: boolean;
    }> = [];

    await initVectorSearch(ctx, {
      createEmbeddings: () => ({}) as never,
      createVectorStore: () =>
        ({
          initialize: async () => {},
          isAvailable: () => false,
          getInitError: () => MISSING_DEPS_ERROR,
        }) as never,
      depsStatus: async () => ({
        transformers: false,
        sqliteVec: false,
        hint: SETUP_HINT,
        errors: [],
      }),
      selfHeal: async (healCtx, opts) => {
        selfHealCalls.push({
          status: healCtx.vectorState?.status,
          hasReinit: typeof opts?.reinit === "function",
        });
        return false;
      },
    });

    expect(selfHealCalls.length).toBe(1);
    expect(selfHealCalls[0]!.status).toBe("unavailable");
    expect(selfHealCalls[0]!.hasReinit).toBe(true);
  });
});
