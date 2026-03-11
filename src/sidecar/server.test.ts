/**
 * Sidecar Server Tests
 *
 * Tests the sidecar HTTP server endpoints using in-memory MemoryStore.
 * Uses HTTP transport (httpOnly mode) for testability.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { startSidecar, stopSidecar } from "./server.js";
import { MemoryStore } from "../memory/store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(base: string, path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  return res.json();
}
async function post(base: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sentinal-sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it("should return 404 for unknown routes", async () => {
    const r = await get(base, "/unknown");
    expect(r.ok).toBe(false);
  });

  // ─── Sessions ─────────────────────────────────────────────────────────

  it("should create a session", async () => {
    const r = await post(base, "/session", { id: "test-1", projectPath: "/test", assistant: "opencode" });
    expect(r.ok).toBe(true);
    expect(r.data.id).toBe("test-1");
    expect(r.data.projectPath).toBe("/test");
    expect(r.data.assistant).toBe("opencode");
    expect(r.data.endTime).toBeNull();
  });

  it("should list active sessions", async () => {
    await post(base, "/session", { id: "s1", projectPath: "/p", assistant: "opencode" });
    const r = await get(base, "/session/active");
    expect(r.ok).toBe(true);
    expect(r.data.length).toBe(1);
    expect(r.data[0].id).toBe("s1");
  });

  it("should end a session", async () => {
    await post(base, "/session", { id: "s2", projectPath: "/p", assistant: "opencode" });
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
    await post(base, "/tdd-state", { action: "set", filePath: "/src/foo.ts", state: "RED_CONFIRMED" });
    const r = await get(base, "/tdd-state?file=/src/foo.ts");
    expect(r.data.state).toBe("RED_CONFIRMED");
  });

  it("should clear TDD state", async () => {
    await post(base, "/tdd-state", { action: "set", filePath: "/src/foo.ts", state: "TEST_WRITTEN" });
    await post(base, "/tdd-state", { action: "clear", filePath: "/src/foo.ts" });
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
      sessionId: "test-session", projectPath: "/test", type: "discovery",
      title: "Test finding", content: "Some content", tags: ["test"],
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
    writeFileSync(planFile, `# Test Plan\n\nStatus: IN PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [ ] Task 1\n- [ ] Task 2\n`);

    await post(base, "/spec/sync", { planPath: planFile, projectPath: tmpDir });
    const r = await get(base, `/spec/current?project=${encodeURIComponent(tmpDir)}`);
    expect(r.ok).toBe(true);
    expect(r.data).not.toBeNull();
    expect(r.data.title).toBe("Test Plan");
  });

  // ─── Notifications ────────────────────────────────────────────────────

  it("should insert a notification", async () => {
    const r = await post(base, "/notification", {
      type: "info", title: "Test notification", message: "Hello", source: "test",
    });
    expect(r.ok).toBe(true);
    expect(r.data.title).toBe("Test notification");
  });
});
