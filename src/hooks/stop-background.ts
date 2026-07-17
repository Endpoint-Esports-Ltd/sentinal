/**
 * Stop-guard background-work awareness (CC 2.1.145+).
 *
 * Claude Code Stop hook input carries `background_tasks` and `session_crons`.
 * When a session tries to stop while a real background task is in flight, the
 * stop is usually legitimate (the background task is the actual work). But we
 * must NEVER let background work suppress a block on the session's OWN
 * in-progress plan — that would abandon the plan the session is responsible for.
 *
 * `shouldSuppressForBackground` encodes that safety rule: suppress ONLY for the
 * weaker block classes (orphaned / stale-owner), never for "self".
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

/**
 * Decide whether an otherwise-blocking stop decision should be suppressed
 * because real background work is in flight.
 *
 * Suppress ONLY when:
 *   - there IS background work, AND
 *   - the block is a WEAKER class (orphaned / stale-owner).
 *
 * NEVER suppress a "self" block (the session's own in-progress plan) or when
 * the ownership class is unknown — fail toward blocking.
 */
export function shouldSuppressForBackground(
  input: SuppressDecisionInput,
): boolean {
  if (!input.hasBackground) return false;
  if (input.ownership === "orphaned" || input.ownership === "stale-owner") {
    return true;
  }
  // "self" or undefined → never suppress.
  return false;
}
