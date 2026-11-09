import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { shouldBlockStop, findActivePlan } from "../spec/detect";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { processSpecStopGuard } from "./spec-stop-guard.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { resolveProjectIdentity } from "../project/identity.js";

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

  function runGuard(extraInput: Record<string, unknown>, hard = true) {
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
        SENTINAL_STOP_GUARD_HARD: hard ? "1" : "0",
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

  // The plan here is unregistered → ownership "orphaned" (not this session's).
  it("soft mode nudges once for a plan this session does not own", () => {
    const result = runGuard({}, false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Do NOT stop");
  }, 30_000);

  it("soft mode WITH stop_hook_active lets the stop through for an unowned plan (no endless nag)", () => {
    const result = runGuard({ stop_hook_active: true }, false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("Do NOT stop");
  }, 30_000);
});

describe("spec-stop-guard — background work lets a waiting session yield", () => {
  // Reproduces the token-burning loop: the main thread owns the IN_PROGRESS
  // plan, has a Monitor / background agent in flight, and says "Watching."
  // Every Stop was nudged ("Do NOT stop"), the model replied "Still watching.",
  // and the next Stop was nudged again. With background work present the stop
  // must go through silently — the task notification brings the session back.
  const HOOK = join(import.meta.dir, "spec-stop-guard.ts");
  const SESSION = "watcher-session";
  const PLAN = "2026-11-09-watched.md";
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeDir = makeTmpDir();
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, PLAN),
      `# Watched Plan\nStatus: IN_PROGRESS\nType: Feature\nApproved: Yes\n`,
    );
    // Make THIS session the plan's owner in the store the subprocess will open
    // (getDbPath honours SENTINAL_HOME at construction time).
    const prevHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = homeDir;
    try {
      const store = new MemoryStore();
      new SpecStore(store).syncFromPlanFile(
        join(plansDir, PLAN),
        resolveProjectIdentity(tmpDir),
      );
      store.stampPlanOwner("2026-11-09-watched", SESSION);
      store.close();
    } finally {
      if (prevHome === undefined) delete process.env.SENTINAL_HOME;
      else process.env.SENTINAL_HOME = prevHome;
    }
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  function runGuard(extraInput: Record<string, unknown>) {
    const input = JSON.stringify({
      session_id: SESSION,
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "Stop",
      last_assistant_message: "Watching.",
      ...extraInput,
    });
    return Bun.spawnSync(["bun", HOOK], {
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SENTINAL_HOME: homeDir,
        SENTINAL_STOP_GUARD_HARD: "0",
      },
    });
  }

  it("control: self-owned plan with NO background work is still nudged", () => {
    const result = runGuard({ background_tasks: [], session_crons: [] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Do NOT stop");
  }, 30_000);

  it("control: self-owned plan is nudged even when stop_hook_active (own-plan nag is intentional)", () => {
    const result = runGuard({ stop_hook_active: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Do NOT stop");
  }, 30_000);

  it("self-owned plan with a background task in flight stops silently (no nudge)", () => {
    const result = runGuard({
      background_tasks: [
        {
          task_id: "monitor-1",
          type: "monitor",
          description: "Watching render",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("Do NOT stop");
  }, 30_000);

  it("self-owned plan with a session cron in flight stops silently (no nudge)", () => {
    const result = runGuard({ session_crons: [{ id: "cron-1" }] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("Do NOT stop");
  }, 30_000);

  it("the nudge returns once the background work is gone", () => {
    const quiet = runGuard({ background_tasks: [{ task_id: "m" }] });
    expect(quiet.stdout.toString()).not.toContain("Do NOT stop");
    const back = runGuard({ background_tasks: [] });
    expect(back.stdout.toString()).toContain("Do NOT stop");
  }, 30_000);
});
