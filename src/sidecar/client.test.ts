/**
 * Sidecar Client Tests
 *
 * Integration tests for SidecarClient against a real sidecar server
 * running in httpOnly mode. Tests the full client → server round-trip.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { startSidecar, stopSidecar, getSidecarPortPath } from "./server.js";
import { SidecarClient, withSidecarOrDirect } from "./client.js";
import { MemoryStore } from "../memory/store.js";
import * as pathsModule from "./paths.js";
import * as fileLogModule from "../utils/file-log.js";

describe("SidecarClient", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let client: SidecarClient;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({
      store,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });

    // Redirect log writes to tmpDir so healthy-path tests can assert no writes
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);

    // Build client directly from known port (bypasses file-based connect)
    const port = (sidecar.server as any).port;
    client = (SidecarClient as any).buildForTest(`http://127.0.0.1:${port}`);
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Health ──────────────────────────────────────────────────────────────

  it("should check health", async () => {
    const h = await client.health();
    expect(h.status).toBe("running");
    expect(h.pid).toBe(process.pid);
  });

  // ─── Sessions ────────────────────────────────────────────────────────────

  it("should create and list sessions", async () => {
    const created = await client.createSession({
      id: "s1",
      projectPath: "/test",
      assistant: "opencode",
    });
    expect(created.id).toBe("s1");

    const active = await client.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("s1");
  });

  it("should end a session", async () => {
    await client.createSession({
      id: "s2",
      projectPath: "/test",
      assistant: "claude",
    });
    await client.endSession("s2");

    const active = await client.getActiveSessions();
    expect(active.length).toBe(0);
  });

  it("should end a session with summary", async () => {
    await client.createSession({
      id: "s3",
      projectPath: "/test",
      assistant: "opencode",
    });
    await client.endSession("s3", { summary: "Did some work" });

    const active = await client.getActiveSessions();
    expect(active.length).toBe(0);
  });

  // ─── TDD State ───────────────────────────────────────────────────────────

  it("should get default TDD state", async () => {
    const state = await client.getTddState("/src/foo.ts");
    expect(state.state).toBe("IDLE");
    expect(state.hasActiveSpec).toBe(false);
  });

  it("should set and get TDD state", async () => {
    await client.setTddState({
      filePath: "/src/foo.ts",
      state: "RED_CONFIRMED",
    });
    const state = await client.getTddState("/src/foo.ts");
    expect(state.state).toBe("RED_CONFIRMED");
  });

  it("should clear TDD state", async () => {
    await client.setTddState({
      filePath: "/src/foo.ts",
      state: "TEST_WRITTEN",
    });
    await client.clearTddState("/src/foo.ts");
    const state = await client.getTddState("/src/foo.ts");
    expect(state.state).toBe("IDLE");
  });

  // ─── Observations ────────────────────────────────────────────────────────

  it("should add an observation", async () => {
    const obs = await client.addObservation({
      sessionId: "test-session",
      projectPath: "/test",
      type: "discovery",
      title: "Test finding",
      content: "Some content",
      tags: ["test"],
    });
    expect(obs.id).toBeGreaterThan(0);
  });

  // ─── Memory Context ──────────────────────────────────────────────────────

  it("should restore empty context", async () => {
    const ctx = await client.restoreContext("/test");
    expect(ctx.hasMemory).toBe(false);
  });

  // ─── Specs ───────────────────────────────────────────────────────────────

  it("should return null for no current spec", async () => {
    const spec = await client.getCurrentSpec("/test");
    expect(spec).toBeNull();
  });

  it("should sync and retrieve a spec", async () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planFile = join(plansDir, "test-plan.md");
    writeFileSync(
      planFile,
      `# Test Plan\n\nStatus: IN PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [ ] Task 1\n- [ ] Task 2\n`,
    );

    await client.syncSpec(planFile, tmpDir);
    const spec = await client.getCurrentSpec(tmpDir);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe("Test Plan");
  });

  // ─── TDD State — List & Clear for Spec ──────────────────────────────────

  it("should list active TDD states", async () => {
    await client.setTddState({ filePath: "/src/a.ts", state: "RED_CONFIRMED" });
    await client.setTddState({ filePath: "/src/b.ts", state: "TEST_WRITTEN" });

    const states = await client.listActiveTddStates();
    expect(states.length).toBe(2);
  });

  it("should list TDD states filtered by specId", async () => {
    // Create specs first (FK constraint on tdd_cycles.spec_id)
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "spec-1.md"),
      "# Spec 1\n\nStatus: PENDING\nType: Feature\n",
    );
    writeFileSync(
      join(plansDir, "spec-2.md"),
      "# Spec 2\n\nStatus: PENDING\nType: Feature\n",
    );
    await client.syncSpec(join(plansDir, "spec-1.md"), tmpDir);
    await client.syncSpec(join(plansDir, "spec-2.md"), tmpDir);

    await client.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-1",
    });
    await client.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-2",
    });

    const states = await client.listActiveTddStates("spec-1");
    expect(states.length).toBe(1);
  });

  it("should clear TDD states for a spec", async () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "spec-x.md"),
      "# Spec X\n\nStatus: PENDING\nType: Feature\n",
    );
    await client.syncSpec(join(plansDir, "spec-x.md"), tmpDir);

    await client.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-x",
    });
    await client.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-x",
    });

    await client.clearTddStatesForSpec("spec-x");

    const states = await client.listActiveTddStates("spec-x");
    expect(states.length).toBe(0);
  });

  // ─── Spec Events ────────────────────────────────────────────────────────

  it("should get spec events", async () => {
    // Create a spec first (events table has FK on spec_id)
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "event-test.md"),
      "# Test\n\nStatus: PENDING\nType: Feature\n",
    );
    await client.syncSpec(join(plansDir, "event-test.md"), tmpDir);

    // Log events directly on store (no client method for logSpecEvent yet)
    store.logSpecEvent({
      specId: "event-test",
      eventType: "phase_change" as any,
      details: { from: "plan", to: "implement" },
    });

    const events = await client.getSpecEvents("event-test");
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("phase_change");
  });

  // ─── Worktree Resolve ───────────────────────────────────────────────────

  it("should resolve worktree by slug — not found", async () => {
    const wt = await client.resolveWorktreeBySlug("nonexistent", tmpDir);
    expect(wt).toBeNull();
  });

  it("should resolve worktree by slug — found", async () => {
    // Insert a spec + worktree directly into the store
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "wt-test.md"),
      "# WT Test\n\nStatus: PENDING\nType: Feature\n",
    );
    await client.syncSpec(join(plansDir, "wt-test.md"), tmpDir);

    // Use the sidecar context's wtStore (same DB as the warm store)
    // Directory must exist on disk — resolution is disk-authoritative
    mkdirSync(join(tmpDir, ".worktrees", "wt-test"), { recursive: true });
    sidecar.ctx.wtStore.insert({
      id: "wt-resolve-1",
      specId: "wt-test",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "wt-test"),
      branchName: "spec/wt-test",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const wt = await client.resolveWorktreeBySlug("wt-test", tmpDir);
    expect(wt).not.toBeNull();
    expect(wt!.branchName).toBe("spec/wt-test");
  });

  // ─── Notifications ───────────────────────────────────────────────────────

  it("should insert a notification", async () => {
    await client.insertNotification({
      type: "info",
      title: "Test notification",
      message: "Hello",
      source: "test",
    });
    // No error = success (server returns void-ish)
  });

  // ─── Compaction Config ───────────────────────────────────────────────────

  it("should return default reserved tokens when no opencode.json", async () => {
    const result = await client.getCompactionConfig(tmpDir);
    expect(result.reserved).toBe(10000);
  });

  it("should return custom reserved tokens from opencode.json", async () => {
    writeFileSync(
      join(tmpDir, "opencode.json"),
      JSON.stringify({ compaction: { reserved: 5000 } }),
    );
    const result = await client.getCompactionConfig(tmpDir);
    expect(result.reserved).toBe(5000);
  });

  it("should NOT write to sidecar.log on healthy requests", async () => {
    // A buildForTest client (no reconnect) on a live sidecar — no log writes
    await client.health();
    await client.ping();

    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    const logLines = fileLogModule.readLastLines(logPath, 20);
    // No client-reconnect lines should appear
    expect(logLines.some((l) => l.includes("connection lost"))).toBe(false);
    expect(logLines.some((l) => l.includes("reconnected via"))).toBe(false);
    expect(logLines.some((l) => l.includes("reconnect failed"))).toBe(false);
  });
});

// ─── tryConnect port file self-heal ──────────────────────────────────────

describe("SidecarClient.connect port file self-heal", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  const {
    readFileSync: readFs,
    unlinkSync: unlinkFs,
    existsSync: existsFs,
  } = require("node:fs");

  beforeEach(async () => {
    // Short path for Unix socket compatibility
    tmpDir = join(tmpdir(), `sc-${Date.now().toString(36)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));

    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(tmpDir, "s.sock"),
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(tmpDir, "sidecar.port"),
    );
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid"),
    );

    // Start sidecar with Unix socket + HTTP
    sidecar = await startSidecar({ store, port: 0, enableVectorSearch: false });
    expect(sidecar.transport).toBe("unix");
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx, sidecar.httpServer);
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("should repair stale port file when connecting via Unix socket", async () => {
    const portPath = join(tmpDir, "sidecar.port");
    const actualPort = (sidecar.httpServer as any).port;

    // Corrupt the port file
    writeFileSync(portPath, "99999", "utf-8");

    // Connect — should succeed via Unix socket and repair the port file
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    // Port file should be repaired with the correct port
    const repairedPort = readFs(portPath, "utf-8").trim();
    expect(repairedPort).toBe(String(actualPort));
  });

  it("should create port file when missing but Unix socket is alive", async () => {
    const portPath = join(tmpDir, "sidecar.port");

    // Remove the port file entirely
    try {
      unlinkFs(portPath);
    } catch {
      /* ok */
    }
    expect(existsFs(portPath)).toBe(false);

    // Connect — should succeed and create port file
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    // Port file should now exist with the correct port
    const actualPort = (sidecar.httpServer as any).port;
    expect(existsFs(portPath)).toBe(true);
    expect(readFs(portPath, "utf-8").trim()).toBe(String(actualPort));
  });
});

// ─── qualityCheck ─────────────────────────────────────────────────────────

describe("SidecarClient.qualityCheck", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sc-qc-${Date.now().toString(36)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));

    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(tmpDir, "s.sock"),
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(tmpDir, "sidecar.port"),
    );
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid"),
    );

    sidecar = await startSidecar({
      store,
      port: 0,
      httpOnly: true,
      enableVectorSearch: false,
    });
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return structured quality check results", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    const projectPath = join(import.meta.dir, "../..");
    const result = await client!.qualityCheck({
      projectPath,
      checks: ["tsc"],
      timeout: 60000,
    });

    expect(result.tsc).toBeDefined();
    expect(typeof result.tsc!.ok).toBe("boolean");
    expect(typeof result.tsc!.durationMs).toBe("number");
    expect(Array.isArray(result.tsc!.errors)).toBe(true);
  }, 60_000);

  it("should support single-file mode", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    const projectPath = join(import.meta.dir, "../..");
    const result = await client!.qualityCheck({
      projectPath,
      filePath: join(import.meta.dir, "client.ts"),
      checks: ["prettier"],
      timeout: 30000,
    });

    expect(result.prettier).toBeDefined();
    expect(typeof result.prettier!.ok).toBe("boolean");
  }, 30_000);
});

// ─── Self-healing reconnect ────────────────────────────────────────────────

describe("SidecarClient self-healing reconnect", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>> | null;
  let respawned: Awaited<ReturnType<typeof startSidecar>> | null;
  let savedAutoStart: typeof SidecarClient.autoStartFn;
  let savedAttempts: number;
  let savedDelay: number;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sc-rc-${Date.now().toString(36)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));
    respawned = null;

    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(tmpDir, "s.sock"),
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(tmpDir, "sidecar.port"),
    );
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid"),
    );

    // Redirect log writes to tmpDir so assertions can check sidecar.log
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);

    savedAutoStart = SidecarClient.autoStartFn;
    savedAttempts = SidecarClient.reconnectAttempts;
    savedDelay = SidecarClient.reconnectDelayMs;
    // Never spawn a real detached sidecar from tests
    SidecarClient.autoStartFn = () => {};
    SidecarClient.reconnectAttempts = 3;
    SidecarClient.reconnectDelayMs = 20;

    sidecar = await startSidecar({
      store,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });
  });

  afterEach(() => {
    SidecarClient.autoStartFn = savedAutoStart;
    SidecarClient.reconnectAttempts = savedAttempts;
    SidecarClient.reconnectDelayMs = savedDelay;
    if (sidecar) stopSidecar(sidecar.server, sidecar.ctx);
    if (respawned) stopSidecar(respawned.server, respawned.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  const obsPayload = {
    sessionId: "rc-session",
    projectPath: "/test",
    type: "fix",
    title: "Reconnect regression",
    content: "memory_save path must survive sidecar restart",
  };

  it("should reconnect and retry after the sidecar restarts (memory_save path)", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    // Sidecar dies (legit session-aware shutdown)...
    stopSidecar(sidecar!.server, sidecar!.ctx);
    sidecar = null;

    // ...and a new one comes up at a different port (port file rewritten)
    const store2 = new MemoryStore(join(tmpDir, "test2.db"));
    respawned = await startSidecar({
      store: store2,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });

    // Cached client must transparently heal and the save must succeed
    const obs = await client!.addObservation(obsPayload);
    expect(obs.id).toBeGreaterThan(0);

    // Log must record the reconnect lifecycle
    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    const logLines = fileLogModule.readLastLines(logPath, 20);
    expect(logLines.some((l) => l.includes("connection lost"))).toBe(true);
    expect(logLines.some((l) => l.includes("reconnected via"))).toBe(true);
  });

  it("should respawn the sidecar via autoStartFn when none is running", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    stopSidecar(sidecar!.server, sidecar!.ctx);
    sidecar = null;

    // autoStartFn simulates `sentinal sidecar start` coming up shortly after
    const store2 = new MemoryStore(join(tmpDir, "test2.db"));
    SidecarClient.autoStartFn = () => {
      void startSidecar({
        store: store2,
        httpOnly: true,
        port: 0,
        enableVectorSearch: false,
      }).then((r) => {
        respawned = r;
      });
    };

    const obs = await client!.addObservation(obsPayload);
    expect(obs.id).toBeGreaterThan(0);

    // Log must record respawn trigger and eventual reconnect
    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    const logLines = fileLogModule.readLastLines(logPath, 20);
    expect(logLines.some((l) => l.includes("connection lost"))).toBe(true);
    expect(
      logLines.some((l) => l.includes("no live sidecar — respawn triggered")),
    ).toBe(true);
    expect(logLines.some((l) => l.includes("reconnected via"))).toBe(true);
  });

  it("should throw an enriched error with method, path, and target when truly unreachable", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    stopSidecar(sidecar!.server, sidecar!.ctx);
    sidecar = null;

    let calls = 0;
    SidecarClient.autoStartFn = () => {
      calls++;
    };

    expect(client!.addObservation(obsPayload)).rejects.toThrow(
      /POST \/observation failed: .*unreachable/,
    );
    // Wait for the rejection to settle before asserting autoStartFn was used
    try {
      await client!.addObservation(obsPayload);
    } catch {
      /* expected */
    }
    expect(calls).toBeGreaterThan(0);

    // Log must record the failed reconnect
    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    const logLines = fileLogModule.readLastLines(logPath, 20);
    expect(logLines.some((l) => l.includes("reconnect failed"))).toBe(true);
  });

  it("should fail in bounded time when a stale socket file points at nothing", async () => {
    const client = await SidecarClient.connect();
    expect(client).not.toBeNull();

    stopSidecar(sidecar!.server, sidecar!.ctx);
    sidecar = null;

    // Crash scenario: sidecar died without cleanup — stale socket file remains,
    // no live server. tryConnect's probe must NOT recurse into reconnect.
    writeFileSync(join(tmpDir, "s.sock"), "", "utf-8");
    writeFileSync(join(tmpDir, "sidecar.port"), "1", "utf-8");

    const start = Date.now();
    let threw = false;
    try {
      await client!.addObservation(obsPayload);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Bounded: one reconnect cycle (attempts × delay) plus slack — not unbounded recursion
    expect(Date.now() - start).toBeLessThan(3000);
  }, 10_000);

  it("should not add reconnect behavior to buildForTest clients", async () => {
    const port = (sidecar!.server as any).port;
    const plain = (SidecarClient as any).buildForTest(
      `http://127.0.0.1:${port}`,
    );

    stopSidecar(sidecar!.server, sidecar!.ctx);
    sidecar = null;

    let calls = 0;
    SidecarClient.autoStartFn = () => {
      calls++;
    };

    expect(plain.addObservation(obsPayload)).rejects.toThrow();
    try {
      await plain.addObservation(obsPayload);
    } catch {
      /* expected */
    }
    expect(calls).toBe(0);

    // Non-reconnecting client must NOT write to sidecar.log
    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    const logLines = fileLogModule.readLastLines(logPath, 20);
    expect(logLines.some((l) => l.includes("connection lost"))).toBe(false);
    expect(logLines.some((l) => l.includes("reconnect failed"))).toBe(false);
  });
});

// ─── withSidecarOrDirect ───────────────────────────────────────────────────

describe("withSidecarOrDirect", () => {
  let isolationDir: string;

  beforeEach(() => {
    // Mock path getters to point at an empty temp dir so connect() never
    // discovers a live sidecar running on the developer's machine.
    isolationDir = join(
      tmpdir(),
      `sentinal-client-isolation-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(isolationDir, { recursive: true });
    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(isolationDir, "sidecar.sock"),
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(isolationDir, "sidecar.port"),
    );
  });

  afterEach(() => {
    mock.restore();
    rmSync(isolationDir, { recursive: true, force: true });
  });

  it("should fall back to direct when sidecar not running", async () => {
    const result = await withSidecarOrDirect(
      async () => "from-sidecar",
      () => "from-direct",
    );
    expect(result).toBe("from-direct");
  });

  it("should use async direct fallback", async () => {
    const result = await withSidecarOrDirect(
      async () => "from-sidecar",
      async () => "from-async-direct",
    );
    expect(result).toBe("from-async-direct");
  });
});
