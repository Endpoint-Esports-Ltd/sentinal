/**
 * Sidecar Server Tests
 *
 * Tests the sidecar HTTP server endpoints using in-memory MemoryStore.
 * Uses HTTP transport (httpOnly mode) for testability.
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
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import {
  startSidecar,
  stopSidecar,
  enableSessionAwareShutdown,
  getLastActivityTime,
  cleanupStaleSessionsOnStartup,
} from "./server.js";
import * as pathsModule from "./paths.js";
import { MemoryStore } from "../memory/store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(base: string, path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  return res.json();
}
async function post(base: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("sidecar server", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let base: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({ store, httpOnly: true, port: 0 });
    base = `http://127.0.0.1:${(sidecar.server as any).port}`;
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should respond to health check", async () => {
    const r = await get(base, "/health");
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe("running");
    expect(r.data.pid).toBe(process.pid);
  });

  it("should include httpPort in health response", async () => {
    const r = await get(base, "/health");
    expect(r.ok).toBe(true);
    expect(typeof r.data.httpPort).toBe("number");
    expect(r.data.httpPort).toBeGreaterThan(0);
  });

  it("should return 404 for unknown routes", async () => {
    const r = await get(base, "/unknown");
    expect(r.ok).toBe(false);
  });

  // ─── Sessions ─────────────────────────────────────────────────────────

  it("should create a session", async () => {
    const r = await post(base, "/session", {
      id: "test-1",
      projectPath: "/test",
      assistant: "opencode",
    });
    expect(r.ok).toBe(true);
    expect(r.data.id).toBe("test-1");
    expect(r.data.projectPath).toBe("/test");
    expect(r.data.assistant).toBe("opencode");
    expect(r.data.endTime).toBeNull();
  });

  it("should list active sessions", async () => {
    await post(base, "/session", {
      id: "s1",
      projectPath: "/p",
      assistant: "opencode",
    });
    const r = await get(base, "/session/active");
    expect(r.ok).toBe(true);
    expect(r.data.length).toBe(1);
    expect(r.data[0].id).toBe("s1");
  });

  it("should end a session", async () => {
    await post(base, "/session", {
      id: "s2",
      projectPath: "/p",
      assistant: "opencode",
    });
    const r = await post(base, "/session/s2/end", {});
    expect(r.ok).toBe(true);

    const active = await get(base, "/session/active");
    expect(active.data.length).toBe(0);
  });

  // ─── TDD State ────────────────────────────────────────────────────────

  it("should return IDLE for unknown TDD state", async () => {
    const r = await get(base, "/tdd-state?file=/src/foo.ts");
    expect(r.ok).toBe(true);
    expect(r.data.state).toBe("IDLE");
    expect(r.data.hasActiveSpec).toBe(false);
  });

  it("should set and get TDD state", async () => {
    await post(base, "/tdd-state", {
      action: "set",
      filePath: "/src/foo.ts",
      state: "RED_CONFIRMED",
    });
    const r = await get(base, "/tdd-state?file=/src/foo.ts");
    expect(r.data.state).toBe("RED_CONFIRMED");
  });

  it("should clear TDD state", async () => {
    await post(base, "/tdd-state", {
      action: "set",
      filePath: "/src/foo.ts",
      state: "TEST_WRITTEN",
    });
    await post(base, "/tdd-state", {
      action: "clear",
      filePath: "/src/foo.ts",
    });
    const r = await get(base, "/tdd-state?file=/src/foo.ts");
    expect(r.data.state).toBe("IDLE");
  });

  it("should reject TDD state query without file param", async () => {
    const r = await get(base, "/tdd-state");
    expect(r.ok).toBe(false);
  });

  // ─── Observations ─────────────────────────────────────────────────────

  it("should add an observation", async () => {
    const r = await post(base, "/observation", {
      sessionId: "test-session",
      projectPath: "/test",
      type: "discovery",
      title: "Test finding",
      content: "Some content",
      tags: ["test"],
    });
    expect(r.ok).toBe(true);
    expect(r.data.id).toBeGreaterThan(0);
    expect(r.data.title).toBe("Test finding");
  });

  // ─── Memory Context ───────────────────────────────────────────────────

  it("should restore context (empty)", async () => {
    const r = await get(base, "/context?project=/test");
    expect(r.ok).toBe(true);
    expect(r.data.hasMemory).toBe(false);
  });

  it("should reject context without project param", async () => {
    const r = await get(base, "/context");
    expect(r.ok).toBe(false);
  });

  // ─── Specs ────────────────────────────────────────────────────────────

  it("should return null for no current spec", async () => {
    const r = await get(base, "/spec/current?project=/test");
    expect(r.ok).toBe(true);
    expect(r.data).toBeNull();
  });

  it("should sync and retrieve a spec", async () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planFile = join(plansDir, "test-plan.md");
    writeFileSync(
      planFile,
      `# Test Plan\n\nStatus: IN PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [ ] Task 1\n- [ ] Task 2\n`
    );

    await post(base, "/spec/sync", { planPath: planFile, projectPath: tmpDir });
    const r = await get(
      base,
      `/spec/current?project=${encodeURIComponent(tmpDir)}`
    );
    expect(r.ok).toBe(true);
    expect(r.data).not.toBeNull();
    expect(r.data.title).toBe("Test Plan");
  });

  // ─── TDD State List ────────────────────────────────────────────────────

  it("should list active TDD states (empty)", async () => {
    const r = await get(base, "/tdd-state/list");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("should list active TDD states with filter", async () => {
    await post(base, "/tdd-state", {
      action: "set",
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
    });
    await post(base, "/tdd-state", {
      action: "set",
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
    });

    const r = await get(base, "/tdd-state/list");
    expect(r.ok).toBe(true);
    expect(r.data.length).toBe(2);
  });

  // ─── Spec Events ──────────────────────────────────────────────────────

  it("should return spec events", async () => {
    // Sync a spec first (FK constraint)
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planFile = join(plansDir, "events-test.md");
    writeFileSync(
      planFile,
      `# Events Test\n\nStatus: IN_PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [ ] Task 1\n`
    );
    await post(base, "/spec/sync", { planPath: planFile, projectPath: tmpDir });

    // Log an event directly
    store.logSpecEvent({
      specId: "events-test",
      eventType: "phase_change",
      details: { from: "plan", to: "implement" },
    });

    const r = await get(base, `/spec/events?spec_id=events-test`);
    expect(r.ok).toBe(true);
    expect(r.data.length).toBe(1);
    expect(r.data[0].eventType).toBe("phase_change");
  });

  it("should reject spec events without spec_id", async () => {
    const r = await get(base, "/spec/events");
    expect(r.ok).toBe(false);
  });

  // ─── Worktree Resolve ─────────────────────────────────────────────────

  it("should return null for unknown worktree slug", async () => {
    const r = await get(base, "/worktree/resolve?slug=nonexistent");
    expect(r.ok).toBe(true);
    expect(r.data).toBeNull();
  });

  it("should reject worktree resolve without slug", async () => {
    const r = await get(base, "/worktree/resolve");
    expect(r.ok).toBe(false);
  });

  // ─── Notifications ────────────────────────────────────────────────────

  it("should insert a notification", async () => {
    const r = await post(base, "/notification", {
      type: "info",
      title: "Test notification",
      message: "Hello",
      source: "test",
    });
    expect(r.ok).toBe(true);
    expect(r.data.title).toBe("Test notification");
  });

  // ─── Ping ───────────────────────────────────────────────────────────────

  it("should respond to /ping", async () => {
    const r = await get(base, "/ping");
    expect(r.ok).toBe(true);
  });
});

// ─── alreadyRunning Port File Update ──────────────────────────────────────

describe("startSidecar alreadyRunning port file sync", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let firstSidecar: Awaited<ReturnType<typeof startSidecar>>;

  beforeEach(async () => {
    // Use short path for Unix sockets (max 104 chars on macOS)
    tmpDir = join(tmpdir(), `s-${Date.now().toString(36)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));

    // Mock paths to use tmpDir (short path for Unix socket compatibility)
    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(tmpDir, "s.sock")
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(tmpDir, "sidecar.port")
    );
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid")
    );

    // Start first sidecar with Unix socket (writes correct port file)
    firstSidecar = await startSidecar({ store, port: 0 });
    expect(firstSidecar.transport).toBe("unix");
    expect(firstSidecar.httpServer).toBeDefined();
  });

  afterEach(() => {
    stopSidecar(firstSidecar.server, firstSidecar.ctx, firstSidecar.httpServer);
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("should update stale port file when detecting alreadyRunning sidecar", async () => {
    const portPath = join(tmpDir, "sidecar.port");
    const actualPort = (firstSidecar.httpServer as any).port;

    // Corrupt the port file to simulate a stale state
    writeFileSync(portPath, "99999", "utf-8");
    expect(readFileSync(portPath, "utf-8").trim()).toBe("99999");

    // Attempt to start a second sidecar — should detect alreadyRunning
    const store2 = new MemoryStore(join(tmpDir, "test2.db"));
    const second = await startSidecar({ store: store2, port: 0 });
    expect(second.alreadyRunning).toBe(true);

    // Port file should now be corrected to the first sidecar's actual HTTP port
    const correctedPort = readFileSync(portPath, "utf-8").trim();
    expect(correctedPort).toBe(String(actualPort));

    store2.close();
  });

  it("should leave valid port file unchanged when detecting alreadyRunning", async () => {
    const portPath = join(tmpDir, "sidecar.port");
    const actualPort = (firstSidecar.httpServer as any).port;

    // Port file is already correct
    expect(readFileSync(portPath, "utf-8").trim()).toBe(String(actualPort));

    // Second start attempt
    const store2 = new MemoryStore(join(tmpDir, "test2.db"));
    const second = await startSidecar({ store: store2, port: 0 });
    expect(second.alreadyRunning).toBe(true);

    // Port file should still be correct
    expect(readFileSync(portPath, "utf-8").trim()).toBe(String(actualPort));

    store2.close();
  });
});

// ─── Cleanup Race Regression ──────────────────────────────────────────────

describe("stopSidecar PID guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-stop-race-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });

    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(
      join(tmpDir, "sidecar.pid")
    );
    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(tmpDir, "sidecar.sock")
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(tmpDir, "sidecar.port")
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("should not delete files when PID file belongs to a different process", () => {
    const pidPath = join(tmpDir, "sidecar.pid");
    const portPath = join(tmpDir, "sidecar.port");
    const socketPath = join(tmpDir, "sidecar.sock");

    // Simulate a newer sidecar owning the files (different PID)
    const otherPid = process.pid + 1000;
    writeFileSync(pidPath, String(otherPid), "utf-8");
    writeFileSync(portPath, "54321", "utf-8");
    writeFileSync(socketPath, "placeholder", "utf-8");

    // Create a minimal mock server/ctx for stopSidecar
    const store = new MemoryStore(join(tmpDir, "test.db"));
    const service = { search: () => [] } as any;
    const specStore = { close: () => {} } as any;
    const mockServer = { stop: () => {} } as any;
    const ctx = { store, service, specStore, wtStore: {} as any };

    // The orphan calls stopSidecar — files should survive
    stopSidecar(mockServer, ctx);

    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8")).toBe(String(otherPid));
    expect(existsSync(portPath)).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
  });

  it("should delete files when PID file matches current process", () => {
    const pidPath = join(tmpDir, "sidecar.pid");
    const portPath = join(tmpDir, "sidecar.port");
    const socketPath = join(tmpDir, "sidecar.sock");

    // Current process owns the files
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(portPath, "54321", "utf-8");
    writeFileSync(socketPath, "placeholder", "utf-8");

    const store = new MemoryStore(join(tmpDir, "test.db"));
    const mockServer = { stop: () => {} } as any;
    const ctx = {
      store,
      service: {} as any,
      specStore: {} as any,
      wtStore: {} as any,
    };

    stopSidecar(mockServer, ctx);

    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(portPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("should delete files when no PID file exists", () => {
    const portPath = join(tmpDir, "sidecar.port");
    const socketPath = join(tmpDir, "sidecar.sock");

    // No PID file, but port/socket exist (edge case)
    writeFileSync(portPath, "54321", "utf-8");
    writeFileSync(socketPath, "placeholder", "utf-8");

    const store = new MemoryStore(join(tmpDir, "test.db"));
    const mockServer = { stop: () => {} } as any;
    const ctx = {
      store,
      service: {} as any,
      specStore: {} as any,
      wtStore: {} as any,
    };

    stopSidecar(mockServer, ctx);

    expect(existsSync(portPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });
});

// ─── Idle Auto-Shutdown ───────────────────────────────────────────────────

describe("idle auto-shutdown", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let base: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({ store, httpOnly: true, port: 0 });
    base = `http://127.0.0.1:${(sidecar.server as any).port}`;
  });

  afterEach(() => {
    try {
      stopSidecar(sidecar.server, sidecar.ctx);
    } catch {
      /* may already be stopped */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should update lastActivityTime on each request", async () => {
    const before = getLastActivityTime();
    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    await get(base, "/health");
    const after = getLastActivityTime();
    expect(after).toBeGreaterThan(before);
  });

  it("should return a cleanup function from enableSessionAwareShutdown", () => {
    const cleanup = enableSessionAwareShutdown(sidecar, {
      checkIntervalMs: 1_000,
      gracePeriodMs: 60_000,
    });
    expect(cleanup).toBeDefined();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("should shutdown after grace period with no active sessions", async () => {
    let shutdownCalled = false;
    // Create an active session so sessionsEverSeen flips true
    sidecar.ctx.store.insertSession({
      id: "temp-session", startTime: Date.now(), endTime: null,
      projectPath: "/test", assistant: "claude-code", summary: null, transcriptPath: null,
    });
    await get(base, "/ping");

    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 40,
      checkIntervalMs: 20,
      fallbackIdleMs: 600_000,
      staleActivityMs: 600_000,
      onShutdown: () => { shutdownCalled = true; },
    });

    // Let the checker see the active session
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdownCalled).toBe(false);

    // End the session — grace period starts
    sidecar.ctx.store.endSession("temp-session");

    // Wait for grace period to elapse
    await new Promise((r) => setTimeout(r, 150));
    expect(shutdownCalled).toBe(true);
    cleanup();
  });

  it("should stay alive when active sessions exist", async () => {
    let shutdownCalled = false;
    // Create an active session (no end_time)
    sidecar.ctx.store.insertSession({
      id: "active-session", startTime: Date.now(), endTime: null,
      projectPath: "/test", assistant: "claude-code", summary: null, transcriptPath: null,
    });
    // Keep activity fresh
    await get(base, "/ping");

    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 30,
      checkIntervalMs: 20,
      fallbackIdleMs: 600_000,
      staleActivityMs: 600_000,
      onShutdown: () => { shutdownCalled = true; },
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(shutdownCalled).toBe(false);
    cleanup();
  });

  it("should shutdown when sessions end after being active (transition flow)", async () => {
    let shutdownCalled = false;
    // Start with active session
    sidecar.ctx.store.insertSession({
      id: "trans-session", startTime: Date.now(), endTime: null,
      projectPath: "/test", assistant: "claude-code", summary: null, transcriptPath: null,
    });
    await get(base, "/ping");

    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 40,
      checkIntervalMs: 20,
      fallbackIdleMs: 600_000,
      staleActivityMs: 600_000,
      onShutdown: () => { shutdownCalled = true; },
    });

    // Session is active — should stay alive
    await new Promise((r) => setTimeout(r, 100));
    expect(shutdownCalled).toBe(false);

    // End the session
    sidecar.ctx.store.endSession("trans-session");

    // Now grace period starts — should shutdown after ~40ms
    await new Promise((r) => setTimeout(r, 150));
    expect(shutdownCalled).toBe(true);
    cleanup();
  });

  it("should fallback to idle timeout when no sessions ever created", async () => {
    let shutdownCalled = false;
    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 60_000,
      checkIntervalMs: 20,
      fallbackIdleMs: 50,
      staleActivityMs: 600_000,
      onShutdown: () => { shutdownCalled = true; },
    });

    // No sessions ever created, idle timeout is 50ms
    await new Promise((r) => setTimeout(r, 150));
    expect(shutdownCalled).toBe(true);
    cleanup();
  });

  it("should not fallback to idle when requests keep coming and no sessions exist", async () => {
    let shutdownCalled = false;
    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 60_000,
      checkIntervalMs: 20,
      fallbackIdleMs: 60,
      staleActivityMs: 600_000,
      onShutdown: () => { shutdownCalled = true; },
    });

    // Keep requests flowing — should prevent fallback idle shutdown
    for (let i = 0; i < 4; i++) {
      await get(base, "/ping");
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(shutdownCalled).toBe(false);
    cleanup();
  });

  it("should shutdown when sessions exist but no HTTP activity for stale threshold", async () => {
    let shutdownCalled = false;
    // Create an active session
    sidecar.ctx.store.insertSession({
      id: "stale-client-session", startTime: Date.now(), endTime: null,
      projectPath: "/test", assistant: "claude-code", summary: null, transcriptPath: null,
    });
    // Don't send any requests — activity is stale from the start

    const cleanup = enableSessionAwareShutdown(sidecar, {
      gracePeriodMs: 40,
      checkIntervalMs: 20,
      fallbackIdleMs: 600_000,
      staleActivityMs: 30, // Very short stale threshold for test
      onShutdown: () => { shutdownCalled = true; },
    });

    // Session exists but activity is older than staleActivityMs (30ms)
    await new Promise((r) => setTimeout(r, 200));
    expect(shutdownCalled).toBe(true);
    cleanup();
  });
});

// ─── Stale Session Cleanup ────────────────────────────────────────────────

describe("stale session cleanup on startup", () => {
  it("should mark sessions older than threshold as ended", () => {
    const tmpDir = makeTmpDir();
    const store = new MemoryStore(join(tmpDir, "test.db"));

    // Create a session started 25 hours ago (stale)
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    store.insertSession({
      id: "stale-session",
      startTime: staleTime,
      endTime: null,
      projectPath: "/old",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    // Create a recent session (should survive)
    store.insertSession({
      id: "fresh-session",
      startTime: Date.now() - 1000,
      endTime: null,
      projectPath: "/new",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const cleaned = cleanupStaleSessionsOnStartup(store);
    expect(cleaned).toBe(1);

    const active = store.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("fresh-session");

    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return 0 when no stale sessions exist", () => {
    const tmpDir = makeTmpDir();
    const store = new MemoryStore(join(tmpDir, "test.db"));

    store.insertSession({
      id: "recent",
      startTime: Date.now() - 1000,
      endTime: null,
      projectPath: "/test",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    const cleaned = cleanupStaleSessionsOnStartup(store);
    expect(cleaned).toBe(0);

    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
