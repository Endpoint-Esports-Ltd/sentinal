/**
 * Prompt Context Hook Tests
 *
 * Tests the UserPromptSubmit hook that injects active spec state
 * into every prompt, ensuring the AI always knows the current
 * workflow state (plan path, current task, progress %).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { buildSpecContext } from "./prompt-context.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writePlan(
  dir: string,
  filename: string,
  content: string,
): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const filePath = join(plansDir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

const ACTIVE_PLAN = `# Test Feature Plan

Created: 2026-03-17
Status: PENDING
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature

## Summary

**Goal:** Test feature

## Progress Tracking

- [x] Task 1: Setup
- [~] Task 2: Implementation
- [ ] Task 3: Testing
- [ ] Task 4: Verification

**Total Tasks:** 4 | **Completed:** 1 | **Remaining:** 3
`;

const VERIFIED_PLAN = `# Verified Plan

Created: 2026-03-17
Status: VERIFIED
Approved: Yes
Type: Feature
`;

const IN_PROGRESS_PLAN = `# In Progress Plan

Created: 2026-03-17
Status: IN_PROGRESS
Approved: Yes
Type: Feature

## Progress Tracking

- [x] Task 1: Setup
- [~] Task 2: Implementation
- [ ] Task 3: Testing

**Total Tasks:** 3 | **Completed:** 1 | **Remaining:** 2
`;

const COMPLETE_PLAN = `# Complete Plan

Created: 2026-03-17
Status: COMPLETE
Approved: Yes
Type: Feature

## Progress Tracking

- [x] Task 1: First
- [x] Task 2: Second

**Total Tasks:** 2 | **Completed:** 2 | **Remaining:** 0
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildSpecContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should return null when no active plan exists", () => {
    const result = buildSpecContext(tmpDir);
    expect(result).toBeNull();
  });

  it("should return null when only terminal plans exist", () => {
    writePlan(tmpDir, "2026-03-17-verified.md", VERIFIED_PLAN);
    const result = buildSpecContext(tmpDir);
    expect(result).toBeNull();
  });

  it("should return context for an active plan", () => {
    writePlan(tmpDir, "2026-03-17-test-feature.md", ACTIVE_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    expect(result).toContain("Active Plan:");
    expect(result).toContain("2026-03-17-test-feature.md");
    expect(result).toContain("PENDING");
  });

  it("should include current task information", () => {
    writePlan(tmpDir, "2026-03-17-test-feature.md", ACTIVE_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    // The in-progress task (Task 2) should be highlighted
    expect(result).toContain("Task 2");
    expect(result).toContain("Implementation");
  });

  it("should include progress percentage", () => {
    writePlan(tmpDir, "2026-03-17-test-feature.md", ACTIVE_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    // 1 of 4 tasks complete = 25%
    expect(result).toContain("25%");
  });

  it("should show remaining task count", () => {
    writePlan(tmpDir, "2026-03-17-test-feature.md", ACTIVE_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    expect(result).toContain("3");
    expect(result).toMatch(/remaining/i);
  });

  it("should display IN_PROGRESS status correctly", () => {
    writePlan(tmpDir, "2026-03-17-in-progress.md", IN_PROGRESS_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    expect(result).toContain("IN_PROGRESS");
    expect(result).toContain("33%"); // 1 of 3 tasks complete
    expect(result).toContain("2 remaining");
  });

  it("should handle COMPLETE status with all tasks done", () => {
    writePlan(tmpDir, "2026-03-17-complete.md", COMPLETE_PLAN);
    const result = buildSpecContext(tmpDir);

    expect(result).not.toBeNull();
    expect(result).toContain("COMPLETE");
    expect(result).toContain("100%");
  });

  it("should handle plans directory not existing", () => {
    // tmpDir exists but has no docs/plans/
    const result = buildSpecContext(tmpDir);
    expect(result).toBeNull();
  });

  it("should handle corrupted plan files gracefully", () => {
    writePlan(tmpDir, "2026-03-17-bad.md", "not a valid plan file\n{{{");
    // Should not throw — parser defaults to PENDING which is an active status,
    // so buildSpecContext returns a best-effort context
    const result = buildSpecContext(tmpDir);
    // Not null because parser defaults PENDING (active) — just verify no crash
    expect(typeof result).toBe("string");
  });
});
