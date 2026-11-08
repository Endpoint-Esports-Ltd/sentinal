/**
 * TDD Tracker Hook (Claude Code)
 *
 * PostToolUse hook that observes tool events and updates TDD cycle state.
 * Tracks the RED-GREEN-REFACTOR cycle:
 *   1. TEST_WRITTEN: AI writes/edits a test file
 *   2. RED_CONFIRMED: Bash output confirms test is failing
 *   3. GREEN_CONFIRMED (→ IDLE): Bash output confirms tests pass
 *
 * State is persisted to SQLite so the tdd-guard PreToolUse hook can read it.
 * This hook is fire-and-forget — errors are silently swallowed.
 *
 * Triggered after: Write, Edit, MultiEdit, Bash (PostToolUse), and Bash
 * (PostToolUseFailure). On Claude Code a failing test run exits non-zero, so
 * it arrives ONLY as PostToolUseFailure, with the output in `error`
 * ("Exit code 1\n…") — without that registration RED could never be confirmed.
 * The two events are mutually exclusive per call; `bashOutputOf` reads both.
 */

import {
  readStdin,
  bashOutputOf,
  type HookInput,
} from "../utils/hook-output.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { isTestFile, getImplPathForTest } from "../utils/tdd.js";
import { resolve } from "node:path";
import {
  resolveFileProject,
  sessionRootsFromCwd,
} from "../project/file-project.js";
import { groupTestScopeByProject } from "../project/test-scope-projects.js";
import type { Spec } from "../spec/types.js";
import {
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
} from "../memory/capture.js";
import {
  filterRowsByTestScope,
  testRunScope,
} from "../utils/test-run-scope.js";

// Re-export for backwards compatibility (implementation moved to src/utils/tdd.ts)
export { getImplPathForTest };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Check if tool name is a file-editing tool. */
function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return ["write", "edit", "multiedit", "patch"].includes(name);
}

/** Check if bash output contains test failure indicators. */
export function hasTestFailure(output: string): boolean {
  return TEST_FAIL_INDICATORS.some((r: RegExp) => r.test(output));
}

/** Check if bash output contains test pass indicators. */
export function hasTestPass(output: string): boolean {
  return TEST_PASS_INDICATORS.some((r: RegExp) => r.test(output));
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

export interface TddTrackerInput {
  toolName: string;
  filePath?: string;
  bashOutput?: string;
  sessionId?: string;
  cwd: string;
  /**
   * The Bash command (D2 of 2026-09-28-deferred-items): scopes both bulk
   * transitions to the tests it ran. Absent/unrecognised → project-wide.
   */
  command?: string;
}

export async function processTddTracking(
  input: TddTrackerInput,
): Promise<void> {
  const { toolName, filePath, bashOutput, sessionId, cwd, command } = input;
  const isBash = toolName === "Bash" && !!bashOutput;
  const testEdit = isEditTool(toolName) && !!filePath && isTestFile(filePath);
  const failed = isBash && hasTestFailure(bashOutput);
  const passed = isBash && !failed && hasTestPass(bashOutput);
  if (!testEdit && !failed && !passed) return;

  // Storage keys: canonical identities (main checkout) of the FILE's project
  // (cross-project scope), so a cycle written from a linked worktree — or from
  // a session in another repo — is visible to its own project.
  const session = sessionRootsFromCwd(cwd);

  const store = new MemoryStore();
  try {
    const specStore = new SpecStore(store);
    // D6: FK writes use the stored project-qualified key. `spec.id` is the
    // bare slug, which is ambiguous once another project has a same-named plan.
    const keyOf = (spec: Spec | null): string | null =>
      spec ? (spec.key ?? spec.id) : null;
    let sessionSpec: Spec | null | undefined;
    const getSessionSpec = (): Spec | null =>
      (sessionSpec ??= specStore.getCurrentSpec(session.identity));
    /** The project's own spec; for a foreign project, else the session's. */
    const specOf = (identity: string): Spec | null =>
      identity === session.identity
        ? getSessionSpec()
        : (specStore.getCurrentSpec(identity) ?? getSessionSpec());

    // Case 1: Test file written/edited — transition to TEST_WRITTEN
    if (testEdit) {
      const implPath = getImplPathForTest(filePath) ?? filePath;
      // D3 — never downgrade: re-editing the test of a RED impl keeps it RED.
      if (store.getTddState(implPath)?.state === "RED_CONFIRMED") return;
      const project = resolveFileProject(resolve(cwd, filePath), session);
      const spec = specOf(project.identity);
      const specKey = keyOf(spec);
      const task = specKey ? specStore.getCurrentTask(specKey) : null;

      store.setTddState({
        filePath: implPath,
        state: "TEST_WRITTEN",
        specId: specKey,
        taskPosition: task?.position ?? null,
        testFilePath: filePath,
        projectPath: project.identity,
      });

      if (specKey) {
        store.logSpecEvent({
          specId: specKey,
          sessionId: sessionId ?? null,
          eventType: "tdd_cycle",
          details: {
            phase: "test_written",
            testFile: filePath,
            implFile: implPath,
            task: task?.position ?? null,
          },
        });
      }
      return;
    }

    // Cases 2/3 — one bulk transition per project the run touched.
    // A `-t`-filtered run proves only some tests of those files: no GREEN.
    const runScope = testRunScope({ command, cwd });
    if (passed && runScope.nameFiltered) return;
    for (const group of groupTestScopeByProject(runScope, session)) {
      const own = group.identity === session.identity;
      // ⛔ Read project-scoped: an unscoped read would transition (and, via
      // the project on the write, re-key) or delete OTHER projects' rows. D1 —
      // and only the rows the run's tests cover (same matcher as the route).
      // A foreign group is read WITHOUT a spec filter: its rows may carry the
      // session's spec id (written before that project had a plan).
      const listKey = own ? keyOf(getSessionSpec()) : null;
      const rows = filterRowsByTestScope(
        store.listActiveTddStates(listKey, group.identity),
        group.scope,
      );
      let changed = false;
      for (const cycle of rows) {
        if (failed && cycle.state === "TEST_WRITTEN") {
          // Case 2: TEST_WRITTEN → RED_CONFIRMED
          store.setTddState({
            filePath: cycle.filePath,
            state: "RED_CONFIRMED",
            lastFailOutput: bashOutput!.slice(0, 2000),
            projectPath: group.identity,
          });
          changed = true;
        } else if (passed && cycle.state === "RED_CONFIRMED") {
          // Case 3: cycle complete, reset to IDLE
          store.clearTddState(cycle.filePath);
          changed = true;
        }
      }
      const specKey = changed ? keyOf(specOf(group.identity)) : null;
      if (specKey) {
        store.logSpecEvent({
          specId: specKey,
          sessionId: sessionId ?? null,
          eventType: "tdd_cycle",
          details: { phase: failed ? "red_confirmed" : "green_confirmed" },
        });
      }
    }
  } finally {
    store.close();
  }
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

/**
 * Map a Claude Code hook payload to tracker input. Shared by this entry point
 * and `sentinal hook shared tdd-tracker` (src/cli/commands/hook.ts). Bash text
 * comes from `bashOutputOf` — CC's Bash `tool_response` has stdout/stderr, not
 * `output`, and a PostToolUseFailure carries it in `error`.
 */
export function trackerInputFromHook(input: HookInput): TddTrackerInput {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;
  return {
    toolName,
    filePath,
    bashOutput: toolName === "Bash" ? bashOutputOf(input) : undefined,
    sessionId: input.session_id,
    cwd: input.cwd,
    command:
      typeof toolInput.command === "string" ? toolInput.command : undefined,
  };
}

async function main(): Promise<void> {
  const input = await readStdin();
  try {
    await processTddTracking(trackerInputFromHook(input));
  } catch {
    // TDD tracker failure is non-fatal
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
