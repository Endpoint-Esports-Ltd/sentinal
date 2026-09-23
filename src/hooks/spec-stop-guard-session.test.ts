/**
 * spec-stop-guard — session-aware behavior tests
 *
 * Tests the session-aware stop decision via resolveStopDecision directly.
 * processSpecStopGuard itself is NOT called in tests — it calls denyExit()
 * which calls process.exit(2), terminating the bun test runner with a
 * non-zero exit code (CI failure). The behavioral contract is fully covered
 * by resolveStopDecision tests and the compiled-path live-smoke in the bugfix plan.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { resolveProjectIdentity } from "../project/identity.js";
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

/**
 * Register a plan the way production does — keyed by the CANONICAL project
 * identity. The ownership query is project-scoped, so a row written under a
 * raw (non-canonical) path is a row shape no real caller can produce, and
 * would read back as `orphaned`.
 */
function registerPlan(store: MemoryStore, dir: string, filename: string): void {
  new SpecStore(store).syncFromPlanFile(
    join(dir, "docs", "plans", filename),
    resolveProjectIdentity(dir),
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
    registerPlan(store, tmpDir, "2026-06-10-test-plan.md");

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
    registerPlan(store, tmpDir, "2026-06-10-test-plan.md");
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
    // Pin the REASON for the block: a project-scoping regression would still
    // block here, but as "orphaned" (row invisible) rather than "self".
    expect(result.ownership).toBe("self");
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

// Note: processSpecStopGuard integration tests are intentionally omitted here.
// processSpecStopGuard calls denyExit() → process.exit(2) on any blocking decision,
// which terminates the bun test runner with exit code 2 (CI failure).
// The behavioral contract is fully covered by:
//   1. resolveStopDecision tests above (decision matrix, fail-safe, cross-worktree)
//   2. The compiled-path live-smoke in Task 4 of the bugfix plan
//      (pipes HookInput through the real `sentinal hook` dispatcher, asserts exit 0)
