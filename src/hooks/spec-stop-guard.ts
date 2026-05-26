import { readStdin, denyExit, type HookInput } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan, shouldBlockStop } from "../spec/detect.js";

/**
 * Core spec-stop-guard logic, exported for testability.
 *
 * Subagent bypass: if `input.agent_type` is present and not "main",
 * this is a subagent completing — do NOT block it.
 *
 * Last-message inclusion: if `input.last_assistant_message` is set,
 * append a snippet to the deny reason.
 */
export async function processSpecStopGuard(input: HookInput): Promise<void> {
  // Subagent bypass: don't block non-main agents from completing
  if (input.agent_type && input.agent_type !== "main") {
    return;
  }

  const gitRoot = await findGitRoot(input.cwd);
  const active = findActivePlan(gitRoot ?? input.cwd);
  let reason = shouldBlockStop(active?.spec.status ?? null);
  if (!reason) return;

  if (input.last_assistant_message) {
    const snippet = input.last_assistant_message.slice(0, 100);
    reason = `${reason} (last message: "${snippet}")`;
  }

  denyExit(reason);
}

async function main(): Promise<void> {
  const input = await readStdin();
  await processSpecStopGuard(input);
}

if (import.meta.main) {
  main().catch(() => {});
}
