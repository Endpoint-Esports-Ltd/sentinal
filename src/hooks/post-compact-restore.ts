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
import { resolveWorkspaceRoot } from "../project/identity.js";

export async function processPostCompactRestore(
  input: HookInput,
): Promise<void> {
  // ⛔ WORKSPACE, never identity. `compact-state.json` is
  // per-session-per-checkout: resolving it through `resolveProjectIdentity`
  // would point every linked worktree at the MAIN checkout's file and leak one
  // worktree's active plan into another.
  //
  // This replaces `findGitRoot(cwd) ?? input.cwd`, which was already
  // worktree-scoped by accident (`--show-toplevel` answers "the worktree I am
  // standing in"). The resolver states the intent, and additionally guarantees
  // a non-empty absolute root for degenerate input, which `?? input.cwd` did
  // not.
  const stateFile = join(
    resolveWorkspaceRoot(input.cwd),
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
