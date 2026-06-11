/**
 * MemoryStore liveness tests — touchSession / isSessionAlive / stampPlanOwner
 *
 * RED phase: tests fail until V11 migration + methods are implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import { SESSION_LIVENESS_WINDOW_MS } from "./types.js";

describe("MemoryStore — session liveness (V11)", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function insertSession(id: string, opts: { alive?: boolean } = {}): void {
    const { alive = true } = opts;
    store.insertSession({
      id,
      startTime: Date.now() - 3_600_000,
      endTime: alive ? null : Date.now() - 60_000,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });
  }

  // ── touchSession ─────────────────────────────────────────────────────────

  it("should persist a last_active timestamp via touchSession", () => {
    insertSession("sess-1");
    const before = Date.now();
    store.touchSession("sess-1");
    const after = Date.now();

    const session = store.getSession("sess-1");
    expect(session).not.toBeNull();
    expect(session!.lastActive).toBeGreaterThanOrEqual(before);
    expect(session!.lastActive).toBeLessThanOrEqual(after);
  });

  it("should accept an explicit timestamp in touchSession", () => {
    insertSession("sess-2");
    const ts = Date.now() - 5_000;
    store.touchSession("sess-2", ts);

    const session = store.getSession("sess-2");
    expect(session!.lastActive).toBe(ts);
  });

  it("should not throw when touching a nonexistent session", () => {
    // Should be a no-op, not an error
    expect(() => store.touchSession("nonexistent-session")).not.toThrow();
  });

  // ── isSessionAlive ────────────────────────────────────────────────────────

  it("should return true when last_active is within the liveness window", () => {
    insertSession("live-sess");
    store.touchSession("live-sess", Date.now() - 60_000); // 1 min ago
    expect(store.isSessionAlive("live-sess")).toBe(true);
  });

  it("should return false when last_active is outside the liveness window", () => {
    insertSession("stale-sess");
    // Touch 2 hours ago — well outside 45-min window
    store.touchSession("stale-sess", Date.now() - 2 * 3_600_000);
    expect(store.isSessionAlive("stale-sess")).toBe(false);
  });

  it("should use start_time as fallback when last_active is null (pre-V11 rows)", () => {
    // Insert session without touching (last_active stays null)
    insertSession("old-sess");
    // start_time is 1 hour ago — outside 45-min window
    expect(store.isSessionAlive("old-sess")).toBe(false);
  });

  it("should return false when session end_time is set (ended session)", () => {
    insertSession("ended-sess", { alive: false });
    store.touchSession("ended-sess", Date.now() - 1_000); // fresh touch but ended
    expect(store.isSessionAlive("ended-sess")).toBe(false);
  });

  it("should return false for nonexistent session", () => {
    expect(store.isSessionAlive("no-such-session")).toBe(false);
  });

  it("should respect custom withinMs override", () => {
    insertSession("custom-sess");
    store.touchSession("custom-sess", Date.now() - 10 * 60 * 1000); // 10 min ago
    // With 5-min window → stale
    expect(store.isSessionAlive("custom-sess", 5 * 60 * 1000)).toBe(false);
    // With 60-min window → alive
    expect(store.isSessionAlive("custom-sess", 60 * 60 * 1000)).toBe(true);
  });

  // ── Liveness window boundary ──────────────────────────────────────────────

  it("should return true at exactly the boundary (just inside)", () => {
    insertSession("boundary-sess");
    // Touch at exactly liveness window - 1s ago
    store.touchSession(
      "boundary-sess",
      Date.now() - SESSION_LIVENESS_WINDOW_MS + 1_000,
    );
    expect(store.isSessionAlive("boundary-sess")).toBe(true);
  });

  it("should return false just outside the boundary", () => {
    insertSession("outside-sess");
    // Touch at exactly liveness window + 1s ago
    store.touchSession(
      "outside-sess",
      Date.now() - SESSION_LIVENESS_WINDOW_MS - 1_000,
    );
    expect(store.isSessionAlive("outside-sess")).toBe(false);
  });

  // ── stampPlanOwner ────────────────────────────────────────────────────────

  it("should stamp a session as the owner of a spec in the DB", () => {
    // Create a spec row first (via SpecStore-level upsert approach)
    const db = store.getRawDb();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test-plan-slug",
      "/test/project",
      "Test Plan",
      "test-plan-slug",
      "feature",
      "IN_PROGRESS",
      1,
      "/test/project/docs/plans/test-plan-slug.md",
      0,
      0,
      now,
      now,
    );

    store.stampPlanOwner("test-plan-slug", "sess-owner");

    const row = db
      .prepare("SELECT session_id FROM specs WHERE id = ?")
      .get("test-plan-slug") as { session_id: string | null };
    expect(row.session_id).toBe("sess-owner");
  });

  it("should not overwrite an existing owner with stampPlanOwner (COALESCE preserve)", () => {
    const db = store.getRawDb();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "owned-plan",
      "/test/project",
      "Owned Plan",
      "owned-plan",
      "feature",
      "IN_PROGRESS",
      1,
      "/test/project/docs/plans/owned-plan.md",
      0,
      0,
      now,
      now,
      "original-owner",
    );

    // stampPlanOwner with a different session — should NOT overwrite
    // (only stamp when session_id IS NULL)
    store.stampPlanOwner("owned-plan", "new-session");

    const row = db
      .prepare("SELECT session_id FROM specs WHERE id = ?")
      .get("owned-plan") as { session_id: string | null };
    // Original owner preserved
    expect(row.session_id).toBe("original-owner");
  });
});
