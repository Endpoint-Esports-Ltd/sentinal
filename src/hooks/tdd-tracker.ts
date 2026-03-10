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
 * Triggered after: Write, Edit, MultiEdit, Bash
 */

import { readStdin } from "../utils/hook-output.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { isTestFile } from "../utils/tdd.js";
import { TEST_FAIL_INDICATORS, TEST_PASS_INDICATORS } from "../memory/capture.js";

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

/**
 * Given a test file path, return the expected implementation file path.
 * src/foo/bar.test.ts → src/foo/bar.ts
 * src/foo/bar.spec.ts → src/foo/bar.ts
 * Returns null if the mapping can't be determined.
 */
export function getImplPathForTest(testFilePath: string): string | null {
  const specMatch = testFilePath.match(/^(.+)\.(spec|test)\.(ts|tsx|js|jsx)$/);
  if (specMatch) {
    return `${specMatch[1]}.${specMatch[3]}`;
  }
  return null;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

export interface TddTrackerInput {
  toolName: string;
  filePath?: string;
  bashOutput?: string;
  sessionId?: string;
  cwd: string;
}

export async function processTddTracking(input: TddTrackerInput): Promise<void> {
  const { toolName, filePath, bashOutput, sessionId, cwd } = input;

  const store = new MemoryStore();
  try {
    const specStore = new SpecStore(store);
    const spec = specStore.getCurrentSpec(cwd);

    // Case 1: Test file written/edited — transition to TEST_WRITTEN
    if (isEditTool(toolName) && filePath && isTestFile(filePath)) {
      const implPath = getImplPathForTest(filePath) ?? filePath;
      const task = spec ? specStore.getCurrentTask(spec.id) : null;

      store.setTddState({
        filePath: implPath,
        state: "TEST_WRITTEN",
        specId: spec?.id ?? null,
        taskPosition: task?.position ?? null,
        testFilePath: filePath,
      });

      if (spec) {
        store.logSpecEvent({
          specId: spec.id,
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
    if (toolName === "Bash" && bashOutput && hasTestFailure(bashOutput)) {
      const states = store.listActiveTddStates(spec?.id ?? null);
      let transitioned = false;

      for (const cycle of states) {
        if (cycle.state === "TEST_WRITTEN") {
          store.setTddState({
            filePath: cycle.filePath,
            state: "RED_CONFIRMED",
            lastFailOutput: bashOutput.slice(0, 2000),
          });
          transitioned = true;
        }
      }

      if (transitioned && spec) {
        store.logSpecEvent({
          specId: spec.id,
          sessionId: sessionId ?? null,
          eventType: "tdd_cycle",
          details: { phase: "red_confirmed" },
        });
      }
      return;
    }

    // Case 3: Bash output shows test pass — cycle complete, reset to IDLE
    if (toolName === "Bash" && bashOutput && hasTestPass(bashOutput)) {
      const states = store.listActiveTddStates(spec?.id ?? null);
      let completed = false;

      for (const cycle of states) {
        if (cycle.state === "RED_CONFIRMED") {
          store.clearTddState(cycle.filePath);
          completed = true;
        }
      }

      if (completed && spec) {
        store.logSpecEvent({
          specId: spec.id,
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

async function main(): Promise<void> {
  const input = await readStdin();

  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const filePath =
    (toolInput.file_path as string) ??
    (toolInput.filePath as string) ??
    (toolInput.path as string) ??
    undefined;

  // Bash output is in tool_response.output
  const bashOutput =
    toolName === "Bash"
      ? ((input.tool_response?.output as string) ?? (toolInput.output as string) ?? undefined)
      : undefined;

  try {
    await processTddTracking({
      toolName,
      filePath,
      bashOutput,
      sessionId: input.session_id,
      cwd: input.cwd,
    });
  } catch {
    // TDD tracker failure is non-fatal
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
