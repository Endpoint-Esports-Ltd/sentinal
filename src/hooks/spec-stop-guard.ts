import { readStdin, denyExit, type HookInput } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { resolveStopDecision } from "../spec/ownership.js";

/**
 * Core spec-stop-guard logic, exported for testability.
 *
 * Session-aware: only blocks the CURRENT session if it owns the active plan
 * (or the plan is unowned/orphaned). Does NOT block if a different live session
 * owns the plan — this fixes the cross-session loop.
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
  const searchDir = gitRoot ?? input.cwd;

  // Resolve session-aware stop decision.
  // Open a direct MemoryStore (same pattern used by other hooks).
  // On any error → fall back to store=null → fail-safe block if active plan found.
  let store = null;
  let ownStore = false;
  try {
    const { MemoryStore } = await import("../memory/store.js");
    const ms = new MemoryStore();
    // Touch the session heartbeat so this session counts as alive during
    // its own stop decision (avoids it being misclassified as stale).
    ms.touchSession(input.session_id);
    store = ms;
    ownStore = true;
  } catch {
    // store remains null → fail-safe block if active plan found
  }

  let decision;
  try {
    decision = resolveStopDecision({
      searchDir,
      currentSessionId: input.session_id,
      store,
    });
  } finally {
    if (ownStore && store) {
      try {
        (store as import("../memory/store.js").MemoryStore).close();
      } catch {
        // non-fatal
      }
    }
  }

  if (!decision.block) return;

  let reason = decision.reason ?? "Active spec plan requires action before stopping.";

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
