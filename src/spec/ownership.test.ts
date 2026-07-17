/**
 * spec/ownership — Session-aware stop-guard decision matrix tests
 *
 * These tests encode the behavior contract from:
 * docs/plans/2026-06-10-multi-plan-session-tracking.md
 *
 * RED phase: all tests fail until src/spec/ownership.ts is implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";
import {
  resolveStopDecision,
  type StopDecisionInput,
} from "./ownership.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function writePlan(dir: string, filename: string, extraHeaders = ""): void {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, filename),
    `# Test Plan\nStatus: IN_PROGRESS\nType: Feature\nApproved: Yes\n${extraHeaders}`,
  );
}

function registerPlan(store: MemoryStore, dir: string, filename: string, sessionId?: string): void {
  const planFile = join(dir, "docs", "plans", filename);
  const specStore = new SpecStore(store);
  specStore.syncFromPlanFile(planFile, dir, sessionId);
}

function makeSession(
  store: MemoryStore,
  id: string,
  projectPath: string,
  opts: { alive?: boolean; lastActiveOffsetMs?: number } = {},
): void {
  const { alive = true, lastActiveOffsetMs = -60_000 } = opts;
  store.insertSession({
    id,
    startTime: Date.now() - 3_600_000,
    endTime: alive ? null : Date.now() - 3_600_000,
    projectPath,
    assistant: "claude-code",
    summary: null,
    transcriptPath: null,
  });
  if (alive) {
    // touch so last_active is fresh (within the liveness window)
    store.touchSession(id, Date.now() + lastActiveOffsetMs);
  }
}

// ─── Decision Matrix ─────────────────────────────────────────────────────────

describe("resolveStopDecision — decision matrix", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ── No active plan ────────────────────────────────────────────────────────

  it("should ALLOW when no active plan exists", () => {
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(result.block).toBe(false);
  });

  // ── Own plan ──────────────────────────────────────────────────────────────

  it("should BLOCK when the plan is owned by the current session", () => {
    writePlan(tmpDir, "2026-06-10-my-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-my-plan.md");
    makeSession(store, "session-A", tmpDir);

    // Stamp ownership so session-A owns the plan
    store.stampPlanOwner("2026-06-10-my-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("IN_PROGRESS");
  });

  // ── Unowned (orphaned) plan ───────────────────────────────────────────────

  it("should BLOCK when the plan has no owner (unowned → claimable)", () => {
    writePlan(tmpDir, "2026-06-10-unowned-plan.md");
    // No session stamped → session_id IS NULL in specs row

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(true);
  });

  // ── Other-live plan ───────────────────────────────────────────────────────

  it("should ALLOW when the plan is owned by a DIFFERENT LIVE session", () => {
    writePlan(tmpDir, "2026-06-10-other-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-other-plan.md");
    makeSession(store, "session-A", tmpDir, { alive: true });
    store.stampPlanOwner("2026-06-10-other-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(false);
  });

  // ── Other-stale plan ─────────────────────────────────────────────────────

  it("should BLOCK when the plan is owned by a DIFFERENT STALE session", () => {
    writePlan(tmpDir, "2026-06-10-stale-plan.md");
    registerPlan(store, tmpDir, "2026-06-10-stale-plan.md");
    // Session-A's last_active is 2 hours ago — outside 45-min window
    makeSession(store, "session-A", tmpDir, {
      alive: true,
      lastActiveOffsetMs: -2 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-stale-plan", "session-A");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(true);
  });

  // ── Concurrent-orphan race: both sessions see unowned plan ────────────────

  it("should BLOCK deterministically when two sessions both see an unowned plan", () => {
    writePlan(tmpDir, "2026-06-10-race-plan.md");
    // Neither session has stamped ownership yet

    const resultA = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    const resultB = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });

    // Both see orphan → both block (safe; no claim write happens inside the guard)
    expect(resultA.block).toBe(true);
    expect(resultB.block).toBe(true);
  });

  // ── Cross-worktree: different searchDir + project_path ───────────────────

  it("should NOT cross-block when sessions use different searchDirs (worktree isolation)", () => {
    const worktreeDir = makeTmpDir("sentinal-wt-test");
    try {
      // Main checkout has an active plan owned by session-A
      writePlan(tmpDir, "2026-06-10-main-plan.md");
      makeSession(store, "session-A", tmpDir, { alive: true });
      store.stampPlanOwner("2026-06-10-main-plan", "session-A");

      // Worktree has its OWN docs/plans (different dir) — no plans there
      // session-B (worktree) should NOT be blocked by the main-checkout plan
      const result = resolveStopDecision({
        searchDir: worktreeDir,
        currentSessionId: "session-B",
        store,
      });
      expect(result.block).toBe(false);
    } finally {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ── Fail-safe: store throws → block ──────────────────────────────────────

  it("should BLOCK (fail-safe) when store throws during ownership check", () => {
    writePlan(tmpDir, "2026-06-10-plan.md");
    // Pass null store to simulate unavailable store
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store: null,
    });
    expect(result.block).toBe(true);
  });
});

// ─── Ownership class (for background-work suppression, Task 2) ────────────────

describe("resolveStopDecision — ownership class", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("tags a self-owned block with ownership 'self'", () => {
    writePlan(tmpDir, "2026-06-10-self.md");
    registerPlan(store, tmpDir, "2026-06-10-self.md");
    makeSession(store, "session-A", tmpDir);
    store.stampPlanOwner("2026-06-10-self", "session-A");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-A",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("self");
  });

  it("tags an unowned block with ownership 'orphaned'", () => {
    writePlan(tmpDir, "2026-06-10-orphan.md");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });

  it("tags a stale-owner block with ownership 'stale-owner'", () => {
    writePlan(tmpDir, "2026-06-10-stale.md");
    registerPlan(store, tmpDir, "2026-06-10-stale.md");
    makeSession(store, "session-A", tmpDir, {
      alive: true,
      lastActiveOffsetMs: -2 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-stale", "session-A");
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("stale-owner");
  });
});

// ─── livenessProbe injection (Task 5 — backward-compat + SDK source) ─────────

describe("resolveStopDecision — injected livenessProbe", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
    writePlan(tmpDir, "2026-06-10-probe.md");
    registerPlan(store, tmpDir, "2026-06-10-probe.md");
    makeSession(store, "owner-X", tmpDir, {
      alive: false, // store says dead
      lastActiveOffsetMs: -5 * 3_600_000,
    });
    store.stampPlanOwner("2026-06-10-probe", "owner-X");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("uses the injected probe over store.isSessionAlive when provided", () => {
    // Store thinks owner-X is dead; probe says alive → ALLOW (different live owner)
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
      livenessProbe: (id) => id === "owner-X", // alive per SDK
    });
    expect(r.block).toBe(false);
  });

  it("is byte-identical to store.isSessionAlive when probe is omitted (CC path)", () => {
    // No probe → falls back to store (owner-X dead) → block as stale-owner
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("stale-owner");
  });
});

// ─── ownerLookup injection (store-free OpenCode path) ────────────────────────

describe("resolveStopDecision — injected ownerLookup (no store needed)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writePlan(tmpDir, "2026-07-17-owned.md");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("resolves ownership via ownerLookup + livenessProbe with store=null (no fail-safe block)", () => {
    // store is null, but ownerLookup + livenessProbe are supplied → full decision.
    // Owner is a DIFFERENT LIVE session → ALLOW.
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
      ownerLookup: () => "owner-live",
      livenessProbe: (id) => id === "owner-live",
    });
    expect(r.block).toBe(false);
  });

  it("blocks with ownership 'self' when ownerLookup returns the current session", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "me",
      store: null,
      ownerLookup: () => "me",
      livenessProbe: () => true,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("self");
  });

  it("blocks 'orphaned' when ownerLookup returns null (unowned)", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
      ownerLookup: () => null,
      livenessProbe: () => true,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });

  it("still fail-safe blocks when store is null AND no ownerLookup provided", () => {
    const r = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store: null,
    });
    expect(r.block).toBe(true);
    expect(r.ownership).toBe("orphaned");
  });
});
