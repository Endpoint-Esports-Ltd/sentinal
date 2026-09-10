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

/** Why a block was issued, used to decide whether background-work suppression is safe. */
export type OwnershipClass = "self" | "orphaned" | "stale-owner";

/**
 * Optional liveness probe. When provided, it is the authoritative source for
 * "is session <id> alive?" and OVERRIDES `store.isSessionAlive`. Used by the
 * OpenCode side to consult the SDK active-sessions API. When omitted, behavior
 * is byte-identical to the store-based path (Claude Code).
 */
export type LivenessProbe = (sessionId: string) => boolean;

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
  /**
   * Optional authoritative liveness probe (e.g. OpenCode SDK active sessions).
   * When omitted, falls back to `store.isSessionAlive` (no behavior change).
   */
  livenessProbe?: LivenessProbe;
  /**
   * Optional owner lookup (spec id → owning session id, or null if unowned).
   * Lets a caller resolve ownership WITHOUT a MemoryStore (e.g. the OpenCode
   * plugin via the sidecar, avoiding a `bun:sqlite` import in the plugin bundle).
   * When omitted, ownership is read from `store`.
   */
  ownerLookup?: (specId: string) => string | null;
}

export interface StopDecision {
  block: boolean;
  /** Human-readable reason, present when block === true. */
  reason?: string;
  /** Why the block was issued (present when block === true). */
  ownership?: OwnershipClass;
}

// ── Decision Logic ────────────────────────────────────────────────────────────

/**
 * Resolve whether the current session should be blocked from stopping.
 *
 * This is the single source of truth for the stop-guard decision in both
 * Claude Code (spec-stop-guard.ts) and OpenCode (plugins/sentinal.ts session.idle).
 */
export function resolveStopDecision(input: StopDecisionInput): StopDecision {
  const { searchDir, currentSessionId, store, livenessProbe, ownerLookup } =
    input;

  // 1. Find the active plan (filesystem scan — fast, no DB needed for candidate)
  const active = findActivePlan(searchDir);
  if (!active) return { block: false };

  // 2. Check if this status even warrants blocking
  const baseReason = shouldBlockStop(active.spec.status ?? null);
  if (!baseReason) return { block: false };

  // 3. Need SOME ownership source: an injected ownerLookup (store-free, e.g. the
  //    OpenCode sidecar path) OR a MemoryStore. Neither → fail-safe block.
  if (!ownerLookup && !store) {
    return { block: true, reason: baseReason, ownership: "orphaned" };
  }

  // 4. Try to resolve ownership; on any error → fail-safe: block
  try {
    const ownerId = ownerLookup
      ? ownerLookup(active.spec.id)
      : getSpecOwner(store!, active.spec.id);

    // 4a. Plan has no owner (unowned/orphaned) → block (claimable by this session)
    if (!ownerId) {
      return { block: true, reason: baseReason, ownership: "orphaned" };
    }

    // 4b. Current session IS the owner → block (this session's own plan)
    if (ownerId === currentSessionId) {
      return { block: true, reason: baseReason, ownership: "self" };
    }

    // 4c. A DIFFERENT session owns the plan — check if it's alive.
    // Prefer the injected authoritative probe (e.g. OpenCode SDK) over the store.
    const ownerAlive = livenessProbe
      ? livenessProbe(ownerId)
      : store!.isSessionAlive(ownerId);
    if (ownerAlive) {
      // Different LIVE session owns this plan → ALLOW (the cross-session fix)
      return { block: false };
    } else {
      // Different STALE/DEAD session owned the plan → block (adoptable orphan)
      return { block: true, reason: baseReason, ownership: "stale-owner" };
    }
  } catch {
    // Fail-safe: any lookup error → block
    return { block: true, reason: baseReason, ownership: "orphaned" };
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
