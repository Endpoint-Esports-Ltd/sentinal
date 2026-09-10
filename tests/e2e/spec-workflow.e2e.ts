// /spec workflow + session-aware stop-guard E2E (Task 5).
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/
// or explicitly: bun test ./tests/e2e/spec-workflow.e2e.ts
//
// Exercises the plan lifecycle + the SESSION-AWARE stop-guard end-to-end in the
// isolated sandbox, through the REAL compiled dispatcher (`sentinal hook shared
// spec-stop-guard`) and the REAL `sentinal register-plan` command.
//
// EMPIRICAL FINDINGS (verified by running each case once in a throwaway
// sandbox before asserting — see the per-case comments below):
//
// 1. WHAT STAMPS OWNERSHIP:
//    `sentinal register-plan <plan> --project <cwd> --session <sid>` calls
//    SpecStore.syncFromPlanFile(plan, project, sid), which upserts the specs
//    row with `session_id = <sid>`. This is the ONLY thing register-plan
//    stamps. It does NOT create a row in the `sessions` table.
//    (getSpecOwner in src/spec/ownership.ts reads specs.session_id.)
//
// 2. WHAT MAKES A SESSION "LIVE":
//    isSessionAlive(id) (src/memory/store.ts) requires a `sessions` ROW with
//    `end_time IS NULL` AND (last_active ?? start_time) within the 45-min
//    liveness window. register-plan creates NO session row, so the owning
//    session is NOT alive from register alone. The `session-start` hook
//    (`sentinal hook shared session-start`) inserts the session row with a
//    fresh start_time and null end_time -> isSessionAlive() -> true.
//    So: register-plan stamps OWNERSHIP; session-start establishes LIVENESS.
//
// 3. OBSERVED STOP-GUARD BEHAVIOR (all exit 0 — soft-by-default, CC 2.1.163):
//    - Owner ("owner-A") stops       -> exit 0, stdout HAS additionalContext
//                                        mentioning IN_PROGRESS (self-owned block).
//    - "session-B" stops while owner-A
//      is LIVE                        -> exit 0, stdout EMPTY (cross-session
//                                        allow — the fix under test).
//    - "session-B" stops while owner-A
//      is NOT live (stale-owner)      -> exit 0, stdout HAS additionalContext
//                                        (adoptable-orphan block).

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";

const T = 120_000;

// Seed an IN_PROGRESS mini plan under <cwd>/docs/plans and return its path.
// findActivePlan scans <searchDir>/docs/plans; since the sandbox cwd is a
// throwaway dir with only this plan, it is unambiguously the active plan.
function seedPlan(cwd: string): string {
  const plansDir = join(cwd, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planPath = join(plansDir, "2026-07-17-mini.md");
  const content = [
    "# Mini Plan",
    "",
    "Status: IN_PROGRESS",
    "Type: Feature",
    "Approved: Yes",
    "",
    "## Summary",
    "",
    "A tiny plan to exercise the session-aware stop-guard end-to-end.",
    "",
    "## Progress Tracking",
    "",
    "- [ ] Task 1: Do the thing",
    "",
  ].join("\n");
  writeFileSync(planPath, content);
  return planPath;
}

// Build a Stop HookInput JSON string for a given session.
function stopInput(sessionId: string, cwd: string): string {
  return JSON.stringify({
    session_id: sessionId,
    agent_type: "main",
    cwd,
    hook_event_name: "Stop",
  });
}

// Drive the real dispatcher: `sentinal hook shared spec-stop-guard`.
function runStopGuard(sb: Sandbox, sessionId: string, cwd: string) {
  return sb.run(["hook", "shared", "spec-stop-guard"], {
    stdin: stopInput(sessionId, cwd),
    cwd,
  });
}

describe("/spec workflow + session-aware stop-guard (E2E)", () => {
  let realSnap: Record<string, string> = {};

  beforeAll(() => {
    // Backstop: snapshot the real user dirs so afterEach can prove non-escape.
    realSnap = snapshotRealDirs();
  });

  let sb: Sandbox | null = null;
  afterEach(() => {
    sb?.cleanup();
    sb = null;
    // Defense-in-depth: no real ~/.sentinal, ~/.claude, ~/.config/opencode
    // mutated by any spawned dispatcher during this test.
    assertNoRealEscape(realSnap);
  });

  it(
    "register-plan stamps ownership into the specs row (not a session row)",
    () => {
      sb = createSandbox();
      const cwd = join(sb.home, "work");
      mkdirSync(cwd, { recursive: true });
      const plan = seedPlan(cwd);

      // WHAT STAMPS OWNERSHIP: register with --session owner-A.
      const reg = sb.run(
        ["register-plan", plan, "--project", cwd, "--session", "owner-A", "--json"],
        { cwd },
      );
      expect(reg.exitCode).toBe(0);

      const parsed = JSON.parse(reg.stdout.trim());
      expect(parsed.id).toBe("2026-07-17-mini");
      expect(parsed.status).toBe("IN_PROGRESS");
      // register-plan echoes the owning session it stamped into specs.session_id.
      expect(parsed.sessionId).toBe("owner-A");

      // The memory DB lives inside the sandbox (never the real ~/.sentinal).
      expect(sb.exists(join(sb.home, ".sentinal", "memory.db"))).toBe(true);
    },
    T,
  );

  it(
    "OWNER stops -> soft-nudge (exit 0 + additionalContext mentioning IN_PROGRESS)",
    () => {
      sb = createSandbox();
      const cwd = join(sb.home, "work");
      mkdirSync(cwd, { recursive: true });
      const plan = seedPlan(cwd);

      const reg = sb.run(
        ["register-plan", plan, "--project", cwd, "--session", "owner-A"],
        { cwd },
      );
      expect(reg.exitCode).toBe(0);

      // OWN-PLAN CASE: the stopping session IS the owner -> block/soft-nudge.
      // Observed empirically: exit 0, stdout carries hookSpecificOutput.
      const res = runStopGuard(sb, "owner-A", cwd);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("additionalContext");
      expect(res.stdout).toContain("IN_PROGRESS");
    },
    T,
  );

  it(
    "DIFFERENT LIVE session stops -> ALLOWED (exit 0, no additionalContext)",
    () => {
      sb = createSandbox();
      const cwd = join(sb.home, "work");
      mkdirSync(cwd, { recursive: true });
      const plan = seedPlan(cwd);

      // 1. Stamp ownership on owner-A.
      const reg = sb.run(
        ["register-plan", plan, "--project", cwd, "--session", "owner-A"],
        { cwd },
      );
      expect(reg.exitCode).toBe(0);

      // 2. Make owner-A LIVE. register-plan does NOT create a session row, so
      //    the session-start hook is what establishes liveness (inserts a
      //    sessions row with fresh start_time + null end_time).
      const start = sb.run(["hook", "shared", "session-start"], {
        stdin: JSON.stringify({
          session_id: "owner-A",
          cwd,
          hook_event_name: "SessionStart",
          transcript_path: null,
        }),
        cwd,
      });
      // session-start may exit 0 with or without output; liveness is the point.
      expect(start.exitCode).toBe(0);

      // 3. A DIFFERENT session (session-B) tries to stop. owner-A owns the
      //    active plan and is LIVE -> cross-session ALLOW.
      //    Observed empirically: exit 0, EMPTY stdout (no block context).
      const res = runStopGuard(sb, "session-B", cwd);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("additionalContext");
      expect(res.stdout.trim()).toBe("");
    },
    T,
  );

  it(
    "DIFFERENT session stops while owner is STALE -> blocked (adoptable orphan)",
    () => {
      // Contrast case that proves the liveness gate is real: without making
      // owner-A live, a different session sees a stale owner and IS blocked.
      sb = createSandbox();
      const cwd = join(sb.home, "work");
      mkdirSync(cwd, { recursive: true });
      const plan = seedPlan(cwd);

      const reg = sb.run(
        ["register-plan", plan, "--project", cwd, "--session", "owner-A"],
        { cwd },
      );
      expect(reg.exitCode).toBe(0);

      // No session-start for owner-A -> owner-A has NO session row -> not alive
      // -> stale-owner -> block. Observed empirically: exit 0 + additionalContext.
      const res = runStopGuard(sb, "session-B", cwd);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("additionalContext");
      expect(res.stdout).toContain("IN_PROGRESS");
    },
    T,
  );
});
