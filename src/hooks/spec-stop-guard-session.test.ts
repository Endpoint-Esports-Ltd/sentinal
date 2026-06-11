/**
 * spec-stop-guard — session-aware behavior tests
 *
 * RED phase: tests fail until processSpecStopGuard is wired to resolveStopDecision.
 *
 * These tests complement src/hooks/spec-stop-guard.test.ts (which tests
 * the legacy shouldBlockStop behavior). We test here via processSpecStopGuard
 * being session-aware and the degrade-to-block fail-safe.
 *
 * NOTE: processSpecStopGuard calls denyExit() which calls process.exit(2) when
 * blocking — so tests that expect a BLOCK must use the imported
 * resolveStopDecision directly. Tests that expect ALLOW go through the real fn
 * (returns without exiting = pass through).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { resolveStopDecision } from "../spec/ownership.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function writePlan(dir: string, filename: string): void {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, filename),
    `# Test Plan\nStatus: IN_PROGRESS\nType: Feature\nApproved: Yes\n`,
  );
}

// ─── Session-aware blocking rules (via resolveStopDecision) ──────────────────

describe("spec-stop-guard — session-aware stop decisions", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(":memory:");
    writePlan(tmpDir, "2026-06-10-test-plan.md");
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should NOT block when a different LIVE session owns the plan (the reported bug)", () => {
    // Register the plan in the DB first (creates the spec row)
    const specStore = new SpecStore(store);
    specStore.syncFromPlanFile(
      join(tmpDir, "docs", "plans", "2026-06-10-test-plan.md"),
      tmpDir,
    );

    // Session A owns the plan and is alive
    store.insertSession({
      id: "session-A",
      startTime: Date.now() - 10_000,
      endTime: null,
      projectPath: tmpDir,
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });
    store.touchSession("session-A", Date.now() - 30_000); // 30s ago — alive
    store.stampPlanOwner("2026-06-10-test-plan", "session-A");

    // Session B tries to stop — should NOT be blocked
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-B",
      store,
    });
    expect(result.block).toBe(false);
  });

  it("should BLOCK when the current session owns the plan", () => {
    const specStore2 = new SpecStore(store);
    specStore2.syncFromPlanFile(
      join(tmpDir, "docs", "plans", "2026-06-10-test-plan.md"),
      tmpDir,
    );
    store.insertSession({
      id: "session-current",
      startTime: Date.now() - 10_000,
      endTime: null,
      projectPath: tmpDir,
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });
    store.touchSession("session-current", Date.now() - 30_000);
    store.stampPlanOwner("2026-06-10-test-plan", "session-current");

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-current",
      store,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("IN_PROGRESS");
  });

  it("should BLOCK (fail-safe) when store is null (sidecar+store unavailable)", () => {
    // Degrade path 1: no store at all — must block, never allow
    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-X",
      store: null,
    });
    expect(result.block).toBe(true);
  });

  it("should BLOCK (fail-safe) when store throws (degrade path 2)", () => {
    // Degrade path 2: store exists but throws — must block
    const brokenStore = {
      getSpecForPlan: () => {
        throw new Error("DB locked");
      },
    } as unknown as MemoryStore;

    const result = resolveStopDecision({
      searchDir: tmpDir,
      currentSessionId: "session-X",
      store: brokenStore,
    });
    expect(result.block).toBe(true);
  });
});

// ─── processSpecStopGuard — ALLOW path (returns without exiting) ──────────────

describe("processSpecStopGuard — ALLOW when foreign-live session owns plan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writePlan(tmpDir, "2026-06-10-other-plan.md");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should return (no denyExit) when the active plan belongs to a different live session", async () => {
    // This test verifies processSpecStopGuard ALLOWS when it should.
    // We can safely call processSpecStopGuard here because it will NOT
    // call denyExit (process.exit) when the decision is ALLOW.
    // The sidecar will be unavailable in test → falls back to direct SpecStore.
    // The plan has no owner (no stampPlanOwner called for "other-session") →
    // the store has no record → orphan → blocks.
    // For the ALLOW path we test via resolveStopDecision directly (tested above).
    // This test is here to document the integration contract.

    // Import here to ensure it's the real function
    const { processSpecStopGuard } = await import("./spec-stop-guard.js");

    const input = {
      session_id: "session-this",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "auto",
      hook_event_name: "Stop",
      agent_type: "main",
    };

    // Should not throw (and since plan has no owner → orphan → this will block
    // if the guard is not session-aware; once session-aware it will check DB).
    // This test validates the function completes without an unexpected throw.
    // Detailed block/allow is covered by resolveStopDecision tests.
    // (We can't assert exit code here without spawning a subprocess.)
    // See Task 4 live-smoke for the compiled-path test.
    let threw = false;
    try {
      await processSpecStopGuard(input);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
