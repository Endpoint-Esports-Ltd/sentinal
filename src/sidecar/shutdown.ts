/**
 * Sidecar shutdown — session-aware auto-shutdown, activity tracking, stale
 * session cleanup and the graceful stop.
 *
 * Split out of `server.ts` purely for length; `server.ts` re-exports every
 * symbol here, so `./server.js` remains the public import path. Only TYPES are
 * imported back from `server.ts` (erased at runtime — no module cycle).
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { logSidecar } from "../utils/file-log.js";
import type { MemoryStore } from "../memory/store.js";
import { createStalenessTick } from "./retire-routes.js";
import {
  detectBinaryStaleness,
  type BinaryStalenessChecker,
} from "./retire-check.js";
import { stopServer } from "../dashboard/lifecycle.js";
import {
  getSidecarSocketPath,
  getSidecarPortPath,
  getSidecarPidPath,
} from "./paths.js";
import type { SidecarContext, SidecarStartResult } from "./server.js";

// ─── Session-Aware Lifecycle ─────────────────────────────────────────────────

/** Default check interval: 30 seconds */
export const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
/** Grace period after last session ends before shutdown (default: 60s) */
export const SESSION_GRACE_PERIOD_MS = 60 * 1000;
/** Idle timeout when no sessions have ever been created (default: 30 min) */
export const FALLBACK_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** If sessions exist but no HTTP activity for this long, treat as stale (default: 1h) */
export const STALE_ACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;

let lastActivityTime = Date.now();

/** Touch the activity timestamp. Called on every incoming request. */
export function touchActivity(): void {
  lastActivityTime = Date.now();
}

/** Get the last activity timestamp (for testing). */
export function getLastActivityTime(): number {
  return lastActivityTime;
}

export interface SessionAwareShutdownOptions {
  /** Grace period in ms after last session ends (default: 60s) */
  gracePeriodMs?: number;
  /** Idle timeout in ms when no sessions ever created (default: 30 min) */
  fallbackIdleMs?: number;
  /** Stale activity threshold in ms (default: 1h) */
  staleActivityMs?: number;
  /** How often to check in ms (default: 30s) */
  checkIntervalMs?: number;
  /** Custom shutdown callback (default: stopSidecar + process.exit) */
  onShutdown?: (reason: string) => void;
  /**
   * Optional callback to stop the dashboard when the sidecar shuts down.
   * When omitted AND onShutdown is not set (production path), the real
   * stopServer() from dashboard/lifecycle is called.
   * When omitted but onShutdown IS set (test/injection mode), no-op —
   * protects test environments from touching real PID files.
   */
  stopDashboardFn?: () => void;
  /**
   * Installed-binary staleness checker polled each tick. Default: a real
   * detectBinaryStaleness() in production; NONE when onShutdown is injected
   * (test mode), mirroring stopDashboardFn. Pass null to disable.
   */
  stalenessChecker?: BinaryStalenessChecker | null;
}

/**
 * Enable session-aware auto-shutdown for the sidecar.
 *
 * - Stays alive while any assistant session is active
 * - Shuts down after gracePeriodMs with zero active sessions
 * - Falls back to idle timeout when no sessions have ever been created (manual start)
 * - Detects stale sessions via HTTP activity threshold
 *
 * Returns a cleanup function that clears the interval.
 */
export function enableSessionAwareShutdown(
  result: SidecarStartResult,
  opts: SessionAwareShutdownOptions = {},
): () => void {
  const gracePeriodMs = opts.gracePeriodMs ?? SESSION_GRACE_PERIOD_MS;
  const fallbackIdleMs = opts.fallbackIdleMs ?? FALLBACK_IDLE_TIMEOUT_MS;
  const staleActivityMs = opts.staleActivityMs ?? STALE_ACTIVITY_THRESHOLD_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  touchActivity();

  let sessionsEverSeen = false;
  let noSessionSince: number | null = null;
  let staleInfo: { count: number; activityAge: number } | null = null;
  const checker =
    opts.stalenessChecker !== undefined
      ? opts.stalenessChecker
      : opts.onShutdown
        ? null
        : detectBinaryStaleness();
  const stalenessTick = checker
    ? createStalenessTick(result.ctx, checker)
    : null;

  const doShutdown = (reason: string) => {
    clearInterval(interval);
    logSidecar(`sidecar: ${reason}`);
    // Stop the dashboard when the sidecar shuts down so it doesn't orphan.
    // Use injected fn in test/custom mode; fall back to real stopServer in production.
    if (opts.stopDashboardFn) {
      try {
        opts.stopDashboardFn();
      } catch {
        /* non-fatal — dashboard stop is best-effort */
      }
    } else if (!opts.onShutdown) {
      // Production path (no custom onShutdown) — stop the real dashboard.
      try {
        stopServer();
        logSidecar("sidecar: dashboard stopped");
      } catch {
        /* non-fatal */
      }
    }
    if (opts.onShutdown) {
      opts.onShutdown(reason);
    } else {
      stopSidecar(result.server, result.ctx, result.httpServer);
      process.exit(0);
    }
  };

  const interval = setInterval(() => {
    stalenessTick?.(); // fire-and-forget; only ever sets ctx.retire
    const store = result.ctx.store;
    let activeSessions: unknown[];
    try {
      activeSessions = store.getActiveSessions();
    } catch {
      // Store closed or unavailable — treat as no sessions
      activeSessions = [];
    }

    if (activeSessions.length > 0) {
      // Sessions exist — check if they're actually alive (recent HTTP activity)
      const activityAge = Date.now() - lastActivityTime;
      if (activityAge >= staleActivityMs) {
        // No HTTP activity for staleActivityMs — sessions are likely from a crashed client
        // Capture stale context before falling through to grace-period logic
        staleInfo = { count: activeSessions.length, activityAge };
        // Fall through to the noSessionSince logic
      } else {
        // Active sessions with recent activity — stay alive
        sessionsEverSeen = true;
        noSessionSince = null;
        staleInfo = null;
        return;
      }
    } else {
      staleInfo = null;
    }

    // No active sessions (or stale sessions only).
    // Retire MUST sit here: after the active-and-fresh return above, and
    // before the sessionsEverSeen split so a never-seen sidecar retires too.
    // Own grace clock — never lastActivityTime, which /retire POSTs reset.
    const retire = result.ctx.retire;
    if (retire) {
      if (noSessionSince === null) noSessionSince = Date.now();
      else if (Date.now() - noSessionSince >= gracePeriodMs) {
        doShutdown(
          `shutting down: retiring (${retire.reason}) — no active sessions for ${gracePeriodMs}ms`,
        );
      }
      return;
    }
    if (sessionsEverSeen) {
      if (noSessionSince === null) {
        noSessionSince = Date.now();
      } else if (Date.now() - noSessionSince >= gracePeriodMs) {
        const reason = staleInfo
          ? `shutting down: ${staleInfo.count} session(s) stale — no HTTP activity for ${staleInfo.activityAge}ms (threshold ${staleActivityMs}ms)`
          : `shutting down: 0 active sessions for ${gracePeriodMs}ms`;
        doShutdown(reason);
      }
    } else {
      // No sessions ever seen — hybrid idle fallback
      const idleMs = Date.now() - lastActivityTime;
      if (idleMs >= fallbackIdleMs) {
        doShutdown(`shutting down: no sessions ever created, idle ${idleMs}ms`);
      }
    }
  }, checkIntervalMs);

  if (interval.unref) interval.unref();

  return () => clearInterval(interval);
}

// ─── Stale Session Cleanup ───────────────────────────────────────────────────

/** Default stale session threshold: 24 hours */
const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Clean up sessions that have been active longer than the threshold.
 * Called on sidecar startup to prevent permanent session leaks.
 * Returns the number of sessions cleaned up.
 */
export function cleanupStaleSessionsOnStartup(store: MemoryStore): number {
  return store.cleanupStaleSessions(STALE_SESSION_THRESHOLD_MS);
}

// ─── Graceful Stop ───────────────────────────────────────────────────────────

/**
 * Graceful shutdown: close store, remove socket/port/pid files.
 *
 * PID guard: only removes artifact files if the PID file still belongs
 * to this process. If a newer sidecar has already written its own PID,
 * the files are left intact so the new sidecar remains discoverable.
 */
export function stopSidecar(
  server: ReturnType<typeof Bun.serve>,
  ctx: SidecarContext,
  httpServer?: ReturnType<typeof Bun.serve>,
): void {
  server.stop(true);
  if (httpServer) httpServer.stop(true);
  ctx.store.close();

  // Only clean up files if this process still owns them
  const pidPath = getSidecarPidPath();
  if (existsSync(pidPath)) {
    try {
      const filePid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isNaN(filePid) && filePid !== process.pid) {
        // A different sidecar owns these files — don't delete
        return;
      }
    } catch {
      /* read failed — safe to clean up */
    }
  }

  for (const path of [getSidecarSocketPath(), getSidecarPortPath(), pidPath]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
