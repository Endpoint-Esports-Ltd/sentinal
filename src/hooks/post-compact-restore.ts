/**
 * Post-Compact Restore Hook
 *
 * Reads `.sentinal/compact-state.json` (written by `pre-compact`) and
 * re-injects the active plan pointer + memory context after compaction.
 *
 * `processPostCompactRestore` is consumed by BOTH the standalone entry
 * below and the CLI dispatcher (`src/cli/commands/hook.ts`).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readStdin,
  hint,
  output,
  type HookInput,
} from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";

export async function processPostCompactRestore(
  input: HookInput,
): Promise<void> {
  const gitRoot = await findGitRoot(input.cwd);
  const stateFile = join(
    gitRoot ?? input.cwd,
    ".sentinal",
    "compact-state.json",
  );
  if (!existsSync(stateFile)) return;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const msgs: string[] = ["Session restored after compaction."];

    if (state.activePlan) {
      msgs.push(`Active plan: ${state.activePlan}`);
      msgs.push(
        "Resume the /spec workflow by reading the plan file and continuing from where you left off.",
      );
    }

    if (state.memoryContext) {
      msgs.push("");
      msgs.push(state.memoryContext);
    }

    output(hint("PostToolUse", msgs.join("\n")));
  } catch {
    /* corrupted state */
  }
}

async function main(): Promise<void> {
  await processPostCompactRestore(await readStdin());
}

if (import.meta.main) {
  main().catch(() => {});
}
