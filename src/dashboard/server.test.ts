/**
 * Dashboard Server Tests
 *
 * Integration tests for the HTTP server and routes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { startServer } from "./server.js";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("Dashboard Server", () => {
  let store: MemoryStore;
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    server = startServer({
      port: 0, // Random available port
      host: "127.0.0.1",
      version: "1.0.0-test",
      store,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    store.close();
  });

  // ─── Health ─────────────────────────────────────────────────────────

  it("should respond to /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.0.0-test");
  });

  it("should include pid in /api/health response", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(typeof body.pid).toBe("number");
    expect(body.pid).toBeGreaterThan(0);
  });

  it("should include X-Sentinal-Version header", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("X-Sentinal-Version")).toBe("1.0.0-test");
  });

  // ─── 404 ────────────────────────────────────────────────────────────

  it("should return 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  // ─── HTML Views ─────────────────────────────────────────────────────

  it("should serve dashboard HTML at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sentinal");
    expect(html).toContain("htmx");
  });

  it("should serve specifications page", async () => {
    const res = await fetch(`${baseUrl}/specifications`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Specifications");
  });

  it("should serve memories page", async () => {
    const res = await fetch(`${baseUrl}/memories`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Memories");
  });

  it("should serve sessions page", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sessions");
  });

  it("should serve settings page", async () => {
    const res = await fetch(`${baseUrl}/settings`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Settings");
  });

  // ─── API Routes ─────────────────────────────────────────────────────

  it("should return dashboard data from /api/dashboard", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.activeSessions).toBeArray();
    expect(body.recentSpecs).toBeArray();
    expect(body.notifications).toBeArray();
    expect(body.stats).toBeDefined();
    expect(body.stats.totalObservations).toBe(0);
  });

  it("should return sessions from /api/sessions", async () => {
    // Insert a test session
    store.insertSession({
      id: "test-session-1",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("test-session-1");
  });

  it("should filter active sessions via query param", async () => {
    store.insertSession({
      id: "active-1",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });
    store.insertSession({
      id: "ended-1",
      startTime: Date.now() - 60000,
      endTime: Date.now(),
      projectPath: "/test",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const res = await fetch(`${baseUrl}/api/sessions?active=true`);
    const body = await jsonBody(res);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("active-1");
  });

  it("should return specs from /api/specs", async () => {
    const res = await fetch(`${baseUrl}/api/specs`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.specs).toBeArray();
  });

  it("should return memories from /api/memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.observations).toBeArray();
    expect(body.page).toBe(1);
  });

  it("should return notifications from /api/notifications", async () => {
    store.insertNotification({ type: "info", title: "Test notification" });

    const res = await fetch(`${baseUrl}/api/notifications`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.notifications).toHaveLength(1);
    expect(body.unreadCount).toBe(1);
  });

  it("should mark all notifications read via POST", async () => {
    store.insertNotification({ type: "info", title: "A" });
    store.insertNotification({ type: "warning", title: "B" });

    const res = await fetch(`${baseUrl}/api/notifications/read`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(store.getUnreadNotificationCount()).toBe(0);
  });

  it("should get settings from /api/settings", async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.modelRouting).toBeDefined();
    expect(body.modelRouting.planning).toBeDefined();
  });

  it("should update settings via POST /api/settings", async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelRouting: { planning: "gpt-5" } }),
    });
    expect(res.status).toBe(200);

    // Verify it was saved
    const getRes = await fetch(`${baseUrl}/api/settings`);
    const body = await jsonBody(getRes);
    expect(body.modelRouting.planning).toBe("gpt-5");
  });

  // ─── CORS ───────────────────────────────────────────────────────────

  it("should handle OPTIONS preflight", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // ─── Fragments ──────────────────────────────────────────────────────

  it("should return dashboard fragment for htmx", async () => {
    const res = await fetch(`${baseUrl}/fragments/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Active Sessions");
  });
});
