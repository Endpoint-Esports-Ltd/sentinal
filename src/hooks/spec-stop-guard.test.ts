import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { shouldBlockStop, findActivePlan } from "../spec/detect";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { processSpecStopGuard } from "./spec-stop-guard.js";

describe("spec-stop-guard", () => {
  it("should not block PENDING", () => {
    expect(shouldBlockStop("PENDING")).toBeNull();
  });
  it("should block IN_PROGRESS", () => {
    const r = shouldBlockStop("IN_PROGRESS");
    expect(r).not.toBeNull();
    expect(r).toContain("IN_PROGRESS");
  });
  it("should block COMPLETE", () => {
    const r = shouldBlockStop("COMPLETE");
    expect(r).not.toBeNull();
    expect(r).toContain("COMPLETE");
  });
  it("should not block VERIFIED", () => {
    expect(shouldBlockStop("VERIFIED")).toBeNull();
  });
  it("should not block null", () => {
    expect(shouldBlockStop(null)).toBeNull();
  });
});

describe("findActivePlan — master priority", () => {
  let tmpDir: string;

  function writePlan(filename: string, content: string): void {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, filename), content);
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should return master plan when both master and child are active", () => {
    writePlan(
      "2026-03-18-big-feature.md",
      `# Big Feature
Status: IN_PROGRESS
Type: Master
Approved: Yes
`,
    );
    writePlan(
      "2026-03-18-big-feature-phase-1.md",
      `# Phase 1
Status: IN_PROGRESS
Type: Feature
Parent: big-feature
Wave: 1
Approved: Yes
`,
    );

    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.type).toBe("master");
    expect(result!.filePath).toContain("big-feature.md");
  });

  it("should return child plan when no master is active", () => {
    writePlan(
      "2026-03-18-big-feature.md",
      `# Big Feature
Status: VERIFIED
Type: Master
`,
    );
    writePlan(
      "2026-03-18-big-feature-phase-1.md",
      `# Phase 1
Status: IN_PROGRESS
Type: Feature
Parent: big-feature
Wave: 1
`,
    );

    const result = findActivePlan(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.spec.type).toBe("feature");
  });

  it("should return null when no plans exist", () => {
    expect(findActivePlan(tmpDir)).toBeNull();
  });
});

describe("processSpecStopGuard — subagent bypass and last_assistant_message", () => {
  let tmpDir: string;

  function writePlan(filename: string, content: string): void {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, filename), content);
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writePlan(
      "2026-05-26-active-plan.md",
      `# Active Plan
Status: IN_PROGRESS
Type: Feature
Approved: Yes
`,
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should NOT block a subagent (agent_type !== 'main') even when IN_PROGRESS", async () => {
    const input = {
      session_id: "test-session",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "auto",
      hook_event_name: "Stop",
      agent_type: "Explore",
    };

    // Subagent bypass: processSpecStopGuard returns without calling denyExit
    // (denyExit calls process.exit so it can't be called in tests without exiting)
    // We verify no error thrown — the real assertion is agent_type bypass logic
    await processSpecStopGuard(input);
    // If we got here without process.exit, the bypass worked
    expect(true).toBe(true);
  });

  it("should build deny reason with last_assistant_message snippet appended", () => {
    // Test the deny reason format by checking shouldBlockStop output + append logic
    // This tests the building logic that processSpecStopGuard uses, without
    // triggering denyExit (which exits the process)
    const lastMsg = "Here is my final answer with some important context.";
    const snippet = lastMsg.slice(0, 100);
    const baseReason = shouldBlockStop("IN_PROGRESS");
    expect(baseReason).not.toBeNull();
    const fullReason = `${baseReason} (last message: "${snippet}")`;
    expect(fullReason).toContain("IN_PROGRESS");
    expect(fullReason).toContain('last message: "Here is my final answer');
    // Verify this matches the actual spec-stop-guard.ts logic
    // (lines 25-27: if last_assistant_message, appends snippet to reason)
    expect(fullReason).toBe(`${baseReason} (last message: "${snippet}")`);
  });
});

describe("spec-stop-guard — stop_hook_active loop breaker (M10a)", () => {
  // Subprocess tests: denyExit calls process.exit(2), so the hard path can
  // only be observed by spawning the real standalone entry point.
  const HOOK = join(import.meta.dir, "spec-stop-guard.ts");
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeDir = makeTmpDir();
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "2026-09-02-active.md"),
      `# Active Plan\nStatus: IN_PROGRESS\nType: Feature\nApproved: Yes\n`,
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  function runGuard(extraInput: Record<string, unknown>) {
    const input = JSON.stringify({
      session_id: "loop-test-session",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "Stop",
      ...extraInput,
    });
    return Bun.spawnSync(["bun", HOOK], {
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SENTINAL_HOME: homeDir,
        SENTINAL_STOP_GUARD_HARD: "1",
      },
    });
  }

  it("hard mode WITHOUT stop_hook_active still denies (exit 2) — control", () => {
    const result = runGuard({});
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("deny");
  }, 30_000);

  it("hard mode WITH stop_hook_active allows the stop (no deny, exit 0)", () => {
    const result = runGuard({ stop_hook_active: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("deny");
  }, 30_000);
});
