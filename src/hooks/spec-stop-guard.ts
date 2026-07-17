import {
  readStdin,
  denyExit,
  stopContext,
  type HookInput,
} from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { resolveStopDecision } from "../spec/ownership.js";
import {
  hasActiveBackgroundWork,
  shouldSuppressForBackground,
} from "./stop-background.js";

/**
 * Core spec-stop-guard logic, exported for testability.
 *
 * Session-aware: only blocks the CURRENT session if it owns the active plan
 * (or the plan is unowned/orphaned). Does NOT block if a different live session
 * owns the plan — this fixes the cross-session loop.
 *
 * Soft by default (CC 2.1.163): emits `hookSpecificOutput.additionalContext` at
 * exit 0 as non-error "Stop hook feedback" that keeps the turn alive under the
 * 8-continuation cap — no hard deny loop. Set `SENTINAL_STOP_GUARD_HARD=1` to
 * restore the legacy hard `denyExit` (exit 2).
 *
 * Background-work aware (CC 2.1.145): when `background_tasks`/`session_crons`
 * report real work in flight, a WEAKER block (orphaned / stale-owner) is
 * suppressed so the stop proceeds — but a self-owned in-progress plan is NEVER
 * suppressed (would abandon the session's own plan).
 *
 * Subagent bypass: if `input.agent_type` is present and not "main",
 * this is a subagent completing — do NOT block it.
 *
 * Last-message inclusion: if `input.last_assistant_message` is set,
 * append a snippet to the reason.
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

  // Background-work awareness: if real background work is in flight, suppress a
  // WEAKER block (orphaned/stale-owner) so the stop proceeds — but never a
  // self-owned in-progress plan.
  if (
    hasActiveBackgroundWork(input) &&
    shouldSuppressForBackground({
      hasBackground: true,
      ownership: decision.ownership,
    })
  ) {
    return;
  }

  let reason = decision.reason ?? "Active spec plan requires action before stopping.";

  if (input.last_assistant_message) {
    const snippet = input.last_assistant_message.slice(0, 100);
    reason = `${reason} (last message: "${snippet}")`;
  }

  // Soft by default (exit 0 + additionalContext keeps the turn alive under the
  // 8-continuation cap). Hard deny only when explicitly opted in.
  if (process.env["SENTINAL_STOP_GUARD_HARD"] === "1") {
    denyExit(reason);
  }
  stopContext(reason);
}

async function main(): Promise<void> {
  const input = await readStdin();
  await processSpecStopGuard(input);
}

if (import.meta.main) {
  main().catch(() => {});
}
