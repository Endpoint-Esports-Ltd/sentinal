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
import { resolveProjectIdentity } from "../project/identity.js";
import {
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
} from "../memory/capture.js";

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
}

export async function processTddTracking(
  input: TddTrackerInput,
): Promise<void> {
  const { toolName, filePath, bashOutput, sessionId, cwd } = input;

  // Storage key: the canonical identity (main checkout), so a cycle written
  // from a linked worktree is visible to — and only to — its own project.
  const project = resolveProjectIdentity(cwd);

  const store = new MemoryStore();
  try {
    const specStore = new SpecStore(store);
    const spec = specStore.getCurrentSpec(project);
    // D6: FK writes use the stored project-qualified key. `spec.id` is the
    // bare slug, which is ambiguous once another project has a same-named plan.
    const specKey = spec ? (spec.key ?? spec.id) : null;

    // Case 1: Test file written/edited — transition to TEST_WRITTEN
    if (isEditTool(toolName) && filePath && isTestFile(filePath)) {
      const implPath = getImplPathForTest(filePath) ?? filePath;
      const task = spec ? specStore.getCurrentTask(specKey!) : null;

      store.setTddState({
        filePath: implPath,
        state: "TEST_WRITTEN",
        specId: specKey,
        taskPosition: task?.position ?? null,
        testFilePath: filePath,
        projectPath: project,
      });

      if (spec) {
        store.logSpecEvent({
          specId: specKey!,
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

    // Case 2: Bash output shows test failure — transition TEST_WRITTEN → RED_CONFIRMED
    // ⛔ Both bulk cases read project-scoped: an unscoped read would transition
    // (and, via the project on the write, re-key) or delete OTHER projects' rows.
    if (toolName === "Bash" && bashOutput && hasTestFailure(bashOutput)) {
      const states = store.listActiveTddStates(specKey, project);
      let transitioned = false;

      for (const cycle of states) {
        if (cycle.state === "TEST_WRITTEN") {
          store.setTddState({
            filePath: cycle.filePath,
            state: "RED_CONFIRMED",
            lastFailOutput: bashOutput.slice(0, 2000),
            projectPath: project,
          });
          transitioned = true;
        }
      }

      if (transitioned && spec) {
        store.logSpecEvent({
          specId: specKey!,
          sessionId: sessionId ?? null,
          eventType: "tdd_cycle",
          details: { phase: "red_confirmed" },
        });
      }
      return;
    }

    // Case 3: Bash output shows test pass — cycle complete, reset to IDLE
    if (toolName === "Bash" && bashOutput && hasTestPass(bashOutput)) {
      const states = store.listActiveTddStates(specKey, project);
      let completed = false;

      for (const cycle of states) {
        if (cycle.state === "RED_CONFIRMED") {
          store.clearTddState(cycle.filePath);
          completed = true;
        }
      }

      if (completed && spec) {
        store.logSpecEvent({
          specId: specKey!,
          sessionId: sessionId ?? null,
          eventType: "tdd_cycle",
          details: { phase: "green_confirmed" },
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
