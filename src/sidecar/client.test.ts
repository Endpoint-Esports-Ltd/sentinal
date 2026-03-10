/**
 * Sidecar Client Tests
 *
 * Integration tests for SidecarClient against a real sidecar server
 * running in httpOnly mode. Tests the full client → server round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { startSidecar, stopSidecar, getSidecarPortPath } from "./server.js";
import { SidecarClient, withSidecarOrDirect } from "./client.js";
import { MemoryStore } from "../memory/store.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SidecarClient", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: ReturnType<typeof startSidecar>;
  let client: SidecarClient;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = startSidecar({ store, httpOnly: true, port: 0 });

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
    await client.createSession({ id: "s2", projectPath: "/test", assistant: "claude" });
    await client.endSession("s2");

    const active = await client.getActiveSessions();
    expect(active.length).toBe(0);
  });

  it("should end a session with summary", async () => {
    await client.createSession({ id: "s3", projectPath: "/test", assistant: "opencode" });
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
    await client.setTddState({ filePath: "/src/foo.ts", state: "RED_CONFIRMED" });
    const state = await client.getTddState("/src/foo.ts");
    expect(state.state).toBe("RED_CONFIRMED");
  });

  it("should clear TDD state", async () => {
    await client.setTddState({ filePath: "/src/foo.ts", state: "TEST_WRITTEN" });
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
