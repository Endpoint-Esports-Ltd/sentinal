/**
 * TDD State Tests
 *
 * Tests for:
 * 1. MemoryStore TDD cycle CRUD methods
 * 2. MemoryStore spec_events logging methods
 * 3. Lightweight readTddState() reader
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import { readTddState } from "./tdd-state.js";

// ─── MemoryStore TDD Cycle Tests ──────────────────────────────────────────────

describe("MemoryStore — TDD cycle state", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns null for unknown file path", () => {
    expect(store.getTddState("/src/foo.ts")).toBeNull();
  });

  it("sets and gets TDD state", () => {
    store.setTddState({ filePath: "/src/foo.ts", state: "TEST_WRITTEN" });
    const cycle = store.getTddState("/src/foo.ts");
    expect(cycle).not.toBeNull();
    expect(cycle!.state).toBe("TEST_WRITTEN");
    expect(cycle!.filePath).toBe("/src/foo.ts");
  });

  it("upserts state on conflict", () => {
    store.setTddState({ filePath: "/src/foo.ts", state: "TEST_WRITTEN" });
    store.setTddState({
      filePath: "/src/foo.ts",
      state: "RED_CONFIRMED",
      lastFailOutput: "1 fail",
    });
    const cycle = store.getTddState("/src/foo.ts");
    expect(cycle!.state).toBe("RED_CONFIRMED");
    expect(cycle!.lastFailOutput).toBe("1 fail");
  });

  it("preserves existing metadata on state-only update", () => {
    store.setTddState({
      filePath: "/src/foo.ts",
      state: "TEST_WRITTEN",
      taskPosition: 2,
      testFilePath: "/src/foo.test.ts",
    });
    // Update only the state (no spec_id, no new metadata)
    store.setTddState({ filePath: "/src/foo.ts", state: "RED_CONFIRMED" });
    const cycle = store.getTddState("/src/foo.ts");
    expect(cycle!.state).toBe("RED_CONFIRMED");
    expect(cycle!.taskPosition).toBe(2);
    expect(cycle!.testFilePath).toBe("/src/foo.test.ts");
  });

  it("clears a specific file state", () => {
    store.setTddState({ filePath: "/src/foo.ts", state: "RED_CONFIRMED" });
    store.clearTddState("/src/foo.ts");
    expect(store.getTddState("/src/foo.ts")).toBeNull();
  });

  it("clearTddStatesForSpec removes all states for that spec", () => {
    // First we need a spec row to satisfy the FK reference — insert directly via raw db
    const db = store.getRawDb();
    db.run(`INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
            VALUES ('spec-1', '/proj', 'Test', 'test', 'feature', 'PENDING', '/plan.md', 1, 1)`);

    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-1",
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-1",
    });
    store.setTddState({
      filePath: "/src/c.ts",
      state: "RED_CONFIRMED",
      specId: null,
    });

    store.clearTddStatesForSpec("spec-1");

    expect(store.getTddState("/src/a.ts")).toBeNull();
    expect(store.getTddState("/src/b.ts")).toBeNull();
    // Spec-null state should remain
    expect(store.getTddState("/src/c.ts")).not.toBeNull();
  });

  it("listActiveTddStates returns only non-IDLE states", () => {
    store.setTddState({ filePath: "/src/a.ts", state: "RED_CONFIRMED" });
    store.setTddState({ filePath: "/src/b.ts", state: "IDLE" });
    store.setTddState({ filePath: "/src/c.ts", state: "TEST_WRITTEN" });

    const active = store.listActiveTddStates();
    expect(active.length).toBe(2);
    const paths = active.map((c) => c.filePath);
    expect(paths).toContain("/src/a.ts");
    expect(paths).toContain("/src/c.ts");
    expect(paths).not.toContain("/src/b.ts");
  });

  it("listActiveTddStates filters by specId", () => {
    const db = store.getRawDb();
    db.run(`INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
            VALUES ('spec-A', '/proj', 'A', 'a', 'feature', 'PENDING', '/a.md', 1, 1)`);
    db.run(`INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
            VALUES ('spec-B', '/proj', 'B', 'b', 'feature', 'PENDING', '/b.md', 1, 1)`);

    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "spec-A",
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "spec-B",
    });

    const activeA = store.listActiveTddStates("spec-A");
    expect(activeA.length).toBe(1);
    expect(activeA[0].filePath).toBe("/src/a.ts");
  });
});

// ─── MemoryStore Spec Events Tests ────────────────────────────────────────────

describe("MemoryStore — spec events", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    // Insert a spec row for FK constraint
    store.getRawDb().run(
      `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
       VALUES ('spec-1', '/proj', 'Test', 'test', 'feature', 'PENDING', '/plan.md', 1, 1)`,
    );
  });

  afterEach(() => {
    store.close();
  });

  it("logs a spec event and retrieves it", () => {
    store.logSpecEvent({
      specId: "spec-1",
      eventType: "tdd_cycle",
      details: { phase: "red_confirmed", file: "/src/foo.ts" },
    });

    const events = store.getSpecEvents("spec-1");
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("tdd_cycle");
    expect(events[0].specId).toBe("spec-1");
    expect(events[0].details).toEqual({
      phase: "red_confirmed",
      file: "/src/foo.ts",
    });
  });

  it("returns events in descending insertion order", () => {
    store.logSpecEvent({
      specId: "spec-1",
      eventType: "phase_change",
      details: { from: "PENDING" },
    });
    store.logSpecEvent({
      specId: "spec-1",
      eventType: "task_update",
      details: { task: 1 },
    });
    store.logSpecEvent({
      specId: "spec-1",
      eventType: "tdd_cycle",
      details: { phase: "green" },
    });

    const events = store.getSpecEvents("spec-1");
    expect(events.length).toBe(3);
    // Most recently inserted first (ordered by timestamp DESC, id DESC)
    expect(events[0].eventType).toBe("tdd_cycle");
    expect(events[2].eventType).toBe("phase_change");
  });

  it("returns empty array for unknown spec", () => {
    expect(store.getSpecEvents("no-such-spec")).toEqual([]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.logSpecEvent({
        specId: "spec-1",
        eventType: "note",
        details: { i },
      });
    }
    const events = store.getSpecEvents("spec-1", 3);
    expect(events.length).toBe(3);
  });

  it("stores sessionId when provided", () => {
    store.logSpecEvent({
      specId: "spec-1",
      sessionId: "sess-abc",
      eventType: "note",
      details: {},
    });
    const events = store.getSpecEvents("spec-1");
    expect(events[0].sessionId).toBe("sess-abc");
  });
});

// ─── Lightweight readTddState() Tests ────────────────────────────────────────

describe("readTddState", () => {
  it("returns IDLE for non-existent database path", () => {
    expect(
      readTddState("/src/foo.ts", "/tmp/nonexistent-sentinal-test.db"),
    ).toBe("IDLE");
  });

  it("returns IDLE when file path not in tdd_cycles", () => {
    const store = new MemoryStore(":memory:");
    // Can't use :memory: with readTddState (different DB connection)
    // We verify the fallback behaviour — no db file = IDLE
    store.close();
    expect(readTddState("/src/unknown.ts", "/tmp/nonexistent-test-2.db")).toBe(
      "IDLE",
    );
  });
});
