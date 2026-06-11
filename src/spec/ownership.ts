/**
 * Spec Ownership — Session-Aware Stop-Guard Decision
 *
 * Determines whether the current session should be blocked from stopping
 * based on which session owns the active plan and whether that session is alive.
 *
 * Blocking rules (user-approved, 2026-06-10):
 * - No active plan → ALLOW
 * - Plan.session_id == current session → BLOCK (own plan)
 * - Plan.session_id is null/empty → BLOCK (orphaned / unowned — claimable)
 * - Plan.session_id is a DIFFERENT LIVE session → ALLOW (the cross-session fix)
 * - Plan.session_id is a DIFFERENT STALE/DEAD session → BLOCK (adoptable)
 *
 * IMPORTANT: resolveStopDecision is READ-ONLY. It never writes ownership.
 * Ownership is established only at sync/register sites (hook.ts, plugin syncSpec).
 * This means an unregistered plan reads as "unowned" → BLOCK (safe direction).
 * Two concurrent sessions both seeing an unowned plan both BLOCK — no write contention.
 *
 * Fail-safe: any error in the ownership/liveness lookup returns BLOCK, so a
 * broken DB or sidecar can never silently disable the stop-guard.
 */

import { findActivePlan, shouldBlockStop } from "./detect.js";
import type { MemoryStore } from "../memory/store.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StopDecisionInput {
  /** The directory to search for active plans (git root or cwd). */
  searchDir: string;
  /** The session ID of the session that is trying to stop. */
  currentSessionId: string;
  /**
   * The memory store to use for ownership/liveness checks.
   * Pass null to simulate an unavailable store → triggers fail-safe block.
   */
  store: MemoryStore | null;
}

export interface StopDecision {
  block: boolean;
  /** Human-readable reason, present when block === true. */
  reason?: string;
}

// ── Decision Logic ────────────────────────────────────────────────────────────

/**
 * Resolve whether the current session should be blocked from stopping.
 *
 * This is the single source of truth for the stop-guard decision in both
 * Claude Code (spec-stop-guard.ts) and OpenCode (plugins/sentinal.ts session.idle).
 */
export function resolveStopDecision(input: StopDecisionInput): StopDecision {
  const { searchDir, currentSessionId, store } = input;

  // 1. Find the active plan (filesystem scan — fast, no DB needed for candidate)
  const active = findActivePlan(searchDir);
  if (!active) return { block: false };

  // 2. Check if this status even warrants blocking
  const baseReason = shouldBlockStop(active.spec.status ?? null);
  if (!baseReason) return { block: false };

  // 3. If no store available → fail-safe: block (current behavior)
  if (!store) {
    return { block: true, reason: baseReason };
  }

  // 4. Try to resolve ownership; on any error → fail-safe: block
  try {
    const ownerId = getSpecOwner(store, active.spec.id);

    // 4a. Plan has no owner (unowned/orphaned) → block (claimable by this session)
    if (!ownerId) {
      return { block: true, reason: baseReason };
    }

    // 4b. Current session IS the owner → block (this session's own plan)
    if (ownerId === currentSessionId) {
      return { block: true, reason: baseReason };
    }

    // 4c. A DIFFERENT session owns the plan — check if it's alive
    const ownerAlive = store.isSessionAlive(ownerId);
    if (ownerAlive) {
      // Different LIVE session owns this plan → ALLOW (the cross-session fix)
      return { block: false };
    } else {
      // Different STALE/DEAD session owned the plan → block (adoptable orphan)
      return { block: true, reason: baseReason };
    }
  } catch {
    // Fail-safe: any lookup error → block
    return { block: true, reason: baseReason };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up the session_id for a spec from the SQLite store.
 * Returns null when the spec is not in the DB (unregistered) or has no owner.
 */
function getSpecOwner(store: MemoryStore, specId: string): string | null {
  try {
    const db = store.getRawDb();
    const row = db
      .prepare("SELECT session_id FROM specs WHERE id = ?")
      .get(specId) as { session_id: string | null } | null;
    if (!row) return null;
    return row.session_id || null; // treat empty string as null
  } catch {
    return null;
  }
}
