/**
 * TDD Guard Hook (Claude Code)
 *
 * PreToolUse hook that enforces RED-GREEN-REFACTOR methodology.
 * Blocks Write/Edit/MultiEdit on implementation files unless a failing
 * test has been confirmed (state = RED_CONFIRMED).
 *
 * Fast path: lightweight SQLite read (~2ms) via readTddState().
 * Slow path: open MemoryStore only if we might need to block.
 *
 * Only active when there is a current active spec for the project.
 *
 * Triggered before: Write, Edit, MultiEdit
 */

import { deny, readStdin, output, type DenyOutput } from "../utils/hook-output.js";
import { readTddState } from "../memory/tdd-state.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { isTestFile, shouldSkipTddGuard } from "../utils/tdd.js";

// ─── State messages ───────────────────────────────────────────────────────────

const STATE_DESCRIPTIONS: Record<string, string> = {
  IDLE: "no test has been written yet for this file",
  TEST_WRITTEN:
    "a test has been written but not confirmed to fail yet — run the test suite first to see it fail",
  GREEN_CONFIRMED:
    "the previous TDD cycle is complete — write a new failing test for the next requirement before editing this file",
};

const GUARD_INSTRUCTIONS = `\nFollow RED-GREEN-REFACTOR:\n  1. Write a failing test in the companion test file\n  2. Run the test suite and confirm it FAILS\n  3. Only then edit the implementation to make it pass`;

// ─── Core Logic ───────────────────────────────────────────────────────────────

export interface TddGuardInput {
  toolName: string;
  filePath?: string;
  cwd: string;
  dbPath?: string;
}

export function processTddGuard(input: TddGuardInput): DenyOutput | null {
  const { toolName, filePath, cwd, dbPath } = input;

  // Only guard Write/Edit/MultiEdit
  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) return null;
  if (!filePath) return null;

  // Test files are always allowed
  if (isTestFile(filePath)) return null;

  // Convention files (modules, DTOs, enums, etc.) are tested indirectly — skip guard
  if (shouldSkipTddGuard(filePath)) return null;

  // Only TypeScript/TSX implementation files
  if (!/\.(ts|tsx)$/.test(filePath)) return null;

  // Fast path: read TDD state (~2ms, no MemoryStore overhead)
  const state = readTddState(filePath, dbPath);

  // If RED_CONFIRMED, implementation edits are allowed
  if (state === "RED_CONFIRMED") return null;

  // Slow path: check if there's an active spec (only if we might block)
  const store = new MemoryStore(dbPath);
  try {
    const specStore = new SpecStore(store);
    const spec = specStore.getCurrentSpec(cwd);
    if (!spec) return null; // No active spec = no enforcement
  } finally {
    store.close();
  }

  // Active spec exists and state is not RED_CONFIRMED — block
  const stateDesc = STATE_DESCRIPTIONS[state] ?? "TDD state is unknown";
  return deny(
    `[Sentinal TDD Guard] Cannot edit implementation file: ${stateDesc}.${GUARD_INSTRUCTIONS}`,
  );
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

  const result = processTddGuard({ toolName, filePath, cwd: input.cwd });
  if (result) {
    output(result);
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}
