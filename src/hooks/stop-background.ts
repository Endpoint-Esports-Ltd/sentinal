/**
 * Stop-guard background-work awareness (CC 2.1.145+).
 *
 * Claude Code Stop hook input carries `background_tasks` and `session_crons`.
 * When a session tries to stop while a background task is in flight, the stop
 * is a YIELD, not an abandonment: Claude Code re-invokes the session with a
 * task notification when that task completes (Monitor fires, background Bash
 * exits, subagent reports, cron ticks). Nudging the model at that point only
 * buys a "Still watching." reply and another Stop — one wasted model turn per
 * nudge, up to the continuation cap, on every wait. The nudge text ("Resume
 * with /spec … Do NOT stop.") is also wrong advice for a session that is
 * deliberately waiting on its own watcher.
 *
 * So `shouldSuppressForBackground` suppresses the block for EVERY known
 * ownership class — including the session's OWN in-progress plan. The plan is
 * not abandoned: the session comes back when the task completes, and the next
 * Stop without background work is nudged as usual.
 *
 * History: the first version (changelog-top4-adoption, Task 2) suppressed only
 * the weaker classes (orphaned / stale-owner) on the theory that letting a
 * self-owned plan stop would abandon it. In practice that produced the
 * "Watching." / nudge / "Still watching." / nudge loop whenever the main
 * thread waited on a Monitor or a background agent.
 */

import type { HookInput } from "../utils/hook-output.js";
import type { OwnershipClass } from "../spec/ownership.js";

/**
 * True when the Stop input reports at least one active background task or cron.
 * Defensive: only a non-empty array counts; any non-array value is treated as
 * "no background work" (fail toward the normal blocking decision).
 */
export function hasActiveBackgroundWork(input: HookInput): boolean {
  return (
    isNonEmptyArray(input.background_tasks) ||
    isNonEmptyArray(input.session_crons)
  );
}

function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

export interface SuppressDecisionInput {
  /** Whether the Stop input reports active background work. */
  hasBackground: boolean;
  /** The class of block the stop-guard would otherwise issue. */
  ownership: OwnershipClass | undefined;
}

const KNOWN_OWNERSHIP: ReadonlySet<OwnershipClass> = new Set([
  "self",
  "orphaned",
  "stale-owner",
]);

/**
 * Decide whether an otherwise-blocking stop decision should be suppressed
 * because real background work is in flight.
 *
 * Suppress when:
 *   - there IS background work, AND
 *   - the block carries a known ownership class (self / orphaned / stale-owner).
 *
 * An unknown/undefined ownership class is never suppressed (fail toward
 * blocking): it means the decision came from a path this module does not
 * understand.
 */
export function shouldSuppressForBackground(
  input: SuppressDecisionInput,
): boolean {
  if (!input.hasBackground) return false;
  if (input.ownership === undefined) return false;
  return KNOWN_OWNERSHIP.has(input.ownership);
}
