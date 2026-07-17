// Hooks-fire E2E (Layer A, deterministic — no LLM, no real binaries).
//
// Drives Sentinal's REAL hook dispatcher (`sentinal hook <scope> <name>`)
// inside a fully isolated sandbox HOME, feeding real `HookInput` JSON on stdin
// exactly like Claude Code does. Asserts the ACTUAL observed exit codes +
// stdout JSON shapes (probed 2026-07-17, documented per case below).
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default `**/*.test.ts` glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/hooks.e2e.ts   (the ./ prefix is required — bun quirk)
//
// Hook scopes come from targets/claude-code/hooks/hooks.json:
//   - file-checker     → `hook claude file-checker`   (PostToolUse)
//   - tdd-guard        → `hook shared tdd-guard`      (PreToolUse)
//   - spec-stop-guard  → `hook shared spec-stop-guard`(Stop)

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";

// Backstop snapshot of the real user dirs — asserted unchanged after every case.
let realSnapshot: Record<string, string>;

beforeAll(() => {
  realSnapshot = snapshotRealDirs();
});

// Build a HookInput JSON string in the exact Claude Code shape
// (mirrors src/cli/commands/hook.test.ts:30-45).
function hookInput(fields: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "e2e-session",
    transcript_path: "/tmp/t",
    permission_mode: "default",
    ...fields,
  });
}

// A 650-line .ts file exceeds Sentinal's 600-line block threshold.
function bigTsSource(): string {
  return Array.from({ length: 650 }, (_, i) => `export const v${i} = ${i};`).join(
    "\n",
  );
}

describe("hooks-fire E2E — real dispatcher in an isolated sandbox", () => {
  let sb: Sandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
    // Defense-in-depth: no hook run may have mutated the real user dirs.
    assertNoRealEscape(realSnapshot);
  });

  // ── Case 1: file-checker (PostToolUse) ────────────────────────────────────
  //
  // OBSERVED (fresh dist/sentinal, 2026-07-17): a 650-line impl .ts file (650
  // entries joined by "\n", no trailing newline) → exit 2, stdout
  // {"decision":"block","reason":"File is 650 lines (limit: 600)..."} and the
  // reason is also mirrored to stderr (CC only surfaces exit-2 reasons there).
  it(
    "file-checker blocks a >600-line .ts file (exit 2 + decision:block)",
    () => {
      sb = createSandbox();
      const work = join(sb.home, "work");
      mkdirSync(work, { recursive: true });
      const bigFile = join(work, "big.ts");
      writeFileSync(bigFile, bigTsSource());

      const stdin = hookInput({
        cwd: work,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: bigFile },
      });

      const r = sb.run(["hook", "claude", "file-checker"], { stdin, cwd: work });

      expect(r.exitCode).toBe(2);
      const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("650 lines");
      expect(parsed.reason).toContain("limit: 600");
      // Exit-2 reason mirrored to stderr per the CC hook protocol.
      expect(r.stderr).toContain("650 lines");
    },
    120_000,
  );

  // ── Case 2: spec-stop-guard (Stop) ────────────────────────────────────────
  //
  // Seed an IN_PROGRESS plan under the sandbox cwd's docs/plans. The cwd is NOT
  // a git repo, so findGitRoot() → null and searchDir === cwd, so the guard scans
  // <cwd>/docs/plans. The plan is UNOWNED (never registered), so resolveStopDecision
  // classifies it "orphaned" → block=true. Without SENTINAL_STOP_GUARD_HARD the
  // guard takes the SOFT path (stopContext).
  //
  // OBSERVED (probe 2026-07-17): exit 0, stdout
  // {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Active spec
  // plan is IN_PROGRESS ... Do NOT stop."}}
  it(
    "spec-stop-guard soft-surfaces context for an IN_PROGRESS plan (exit 0 + additionalContext)",
    () => {
      sb = createSandbox();
      const work = join(sb.home, "work");
      const plansDir = join(work, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(plansDir, "2026-07-17-mini.md"),
        [
          "# Mini Plan",
          "",
          "Created: 2026-07-17",
          "Status: IN_PROGRESS",
          "Approved: Yes",
          "Type: Feature",
          "",
          "## Summary",
          "A mini plan to drive the stop-guard.",
          "",
          "## Implementation Tasks",
          "### Task 1: Do a thing",
          "- [ ] Task 1: do the thing",
          "",
        ].join("\n"),
      );

      const stdin = hookInput({
        cwd: work,
        hook_event_name: "Stop",
        agent_type: "main",
      });

      const r = sb.run(["hook", "shared", "spec-stop-guard"], {
        stdin,
        cwd: work,
      });

      // SOFT path: keeps the turn alive at exit 0 via additionalContext.
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain(
        "IN_PROGRESS",
      );
      expect(r.stdout).toContain("additionalContext");
    },
    120_000,
  );

  // ── Case 3: tdd-guard (PreToolUse) ────────────────────────────────────────
  //
  // tdd-guard only enforces when there is an ACTIVE spec for the project
  // (specStore.getCurrentSpec(cwd) — queried by project_path). So we first
  // register the seeded IN_PROGRESS plan against the cwd, then attempt a Write on
  // an impl .ts file that has NO companion .test.ts and NO RED_CONFIRMED state.
  //
  // OBSERVED (probe 2026-07-17): exit 2, stdout
  // {"permissionDecision":"deny","reason":"[Sentinal TDD Guard] Cannot edit
  // implementation file: no test has been written yet for this file...."}
  it(
    "tdd-guard blocks a Write on an impl file with no companion test (exit 2 + deny)",
    () => {
      sb = createSandbox();
      const work = join(sb.home, "work");
      const plansDir = join(work, "docs", "plans");
      const srcDir = join(work, "src");
      mkdirSync(plansDir, { recursive: true });
      mkdirSync(srcDir, { recursive: true });

      const planPath = join(plansDir, "2026-07-17-mini.md");
      writeFileSync(
        planPath,
        [
          "# Mini Plan",
          "",
          "Created: 2026-07-17",
          "Status: IN_PROGRESS",
          "Approved: Yes",
          "Type: Feature",
          "",
          "## Summary",
          "A mini plan.",
          "",
          "## Implementation Tasks",
          "### Task 1: Do a thing",
          "- [ ] Task 1: do the thing",
          "",
        ].join("\n"),
      );

      const implFile = join(srcDir, "impl.ts");
      writeFileSync(implFile, "export function foo() {\n  return 1;\n}\n");

      // Register the plan so getCurrentSpec(cwd) returns an active spec —
      // without this the guard has no active spec and would pass through (exit 0).
      const reg = sb.run(
        [
          "register-plan",
          planPath,
          "--project",
          work,
          "--session",
          "e2e-session",
          "--json",
        ],
        { cwd: work },
      );
      expect(reg.exitCode).toBe(0);

      const stdin = hookInput({
        cwd: work,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: implFile },
      });

      const r = sb.run(["hook", "shared", "tdd-guard"], { stdin, cwd: work });

      expect(r.exitCode).toBe(2);
      const parsed = JSON.parse(r.stdout) as {
        permissionDecision: string;
        reason: string;
      };
      expect(parsed.permissionDecision).toBe("deny");
      expect(parsed.reason).toContain("TDD Guard");
      expect(parsed.reason).toContain("no test has been written");
      // Exit-2 reason mirrored to stderr.
      expect(r.stderr).toContain("TDD Guard");
    },
    120_000,
  );
});
