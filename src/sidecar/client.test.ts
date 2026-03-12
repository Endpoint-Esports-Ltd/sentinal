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
import { startSidecar, stopSidecar, getSidecarPortPath } from "./server.js";
import { SidecarClient, withSidecarOrDirect } from "./client.js";
import { MemoryStore } from "../memory/store.js";
import * as pathsModule from "./paths.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SidecarClient", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let client: SidecarClient;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({ store, httpOnly: true, port: 0 });

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
      `# Test Plan\n\nStatus: IN PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [ ] Task 1\n- [ ] Task 2\n`
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
      "# Spec 1\n\nStatus: PENDING\nType: Feature\n"
    );
    writeFileSync(
      join(plansDir, "spec-2.md"),
      "# Spec 2\n\nStatus: PENDING\nType: Feature\n"
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
      "# Spec X\n\nStatus: PENDING\nType: Feature\n"
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
      "# Test\n\nStatus: PENDING\nType: Feature\n"
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
      "# WT Test\n\nStatus: PENDING\nType: Feature\n"
    );
    await client.syncSpec(join(plansDir, "wt-test.md"), tmpDir);

    // Use the sidecar context's wtStore (same DB as the warm store)
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
        .slice(2)}`
    );
    mkdirSync(isolationDir, { recursive: true });
    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(
      join(isolationDir, "sidecar.sock")
    );
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(
      join(isolationDir, "sidecar.port")
    );
  });

  afterEach(() => {
    mock.restore();
    rmSync(isolationDir, { recursive: true, force: true });
  });

  it("should fall back to direct when sidecar not running", async () => {
    const result = await withSidecarOrDirect(
      async () => "from-sidecar",
      () => "from-direct"
    );
    expect(result).toBe("from-direct");
  });

  it("should use async direct fallback", async () => {
    const result = await withSidecarOrDirect(
      async () => "from-sidecar",
      async () => "from-async-direct"
    );
    expect(result).toBe("from-async-direct");
  });
});
