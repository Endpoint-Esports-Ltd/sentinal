/**
 * Sidecar Start Guard (M2a + M2d)
 *
 * Split from lifecycle.ts under the 400-line rule — pure move plus the M2
 * fixes. lifecycle.ts re-exports everything here, so all existing call
 * sites (`require("./lifecycle.js")` in hooks/client/MCP) keep working.
 *
 * M2a — REACHABILITY decides the start, not `kill(pid, 0)` liveness: a
 * recycled PID satisfies the liveness check forever, blocking the sidecar
 * from ever starting while every hook silently degrades to direct mode.
 *
 * M2d — a `wx` start lock (mirroring src/runtime/pidfile-claim.ts) closes
 * the window where N hooks each spawn a starter before any pidfile exists.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getSidecarPidPath } from "./paths.js";
import {
  readSidecarPid,
  isProcessAlive,
  isSidecarReachable,
  cleanupSidecarFiles,
} from "./lifecycle.js";

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Booting grace (M2a): a sidecar writes its pidfile only AFTER its servers
 * are listening, so a pidfile younger than this that is not yet reachable is
 * treated as "still booting" — briefly-unreachable is normal (probe timeout
 * under load), and stampeding it would kill a healthy start. A pidfile OLDER
 * than the grace that is live-but-unreachable is a recycled PID or a wedged
 * sidecar: its files are cleaned and a fresh start proceeds.
 */
export const SIDECAR_BOOT_GRACE_MS = 10_000;

/**
 * A start lock older than this is presumed abandoned (the starter crashed
 * between lock and spawn) and is taken over. Chosen well above normal
 * sidecar boot time (<2s) but short enough that a crashed starter only
 * delays auto-start by seconds — client reconnect polling keeps retrying.
 *
 * A LIVE starter re-touches its lock while awaiting the child's pidfile
 * (see guardStartLock), so age-based takeover only ever claims genuinely
 * dead starters — pidfile-claim.ts's liveness-over-age doctrine.
 */
export const START_LOCK_STALE_MS = 10_000;

/**
 * Re-touch interval for a held start lock while the spawned child boots.
 * Well below START_LOCK_STALE_MS so the lock's mtime can never look stale
 * while the starter is alive and waiting.
 */
export const START_LOCK_TOUCH_INTERVAL_MS = 2_500;

/**
 * Upper bound on lock guarding. A boot slower than this stops being
 * protected: the guard exits, the lock goes stale ~10s later, and takeover
 * is allowed again — bounded, so a hung child can't hold the lock forever.
 */
export const START_LOCK_GUARD_MAX_MS = 60_000;

/**
 * Reachability probe attempts before a live-but-unreachable PID past the
 * boot grace is declared wedged. One blocked event-loop tick (a sidecar
 * doing in-process embedding can exceed the 2s probe timeout) must not
 * trigger cleanup + a second spawn.
 */
export const SIDECAR_PROBE_ATTEMPTS = 2;

/** Delay between reachability probe attempts. */
export const SIDECAR_PROBE_RETRY_DELAY_MS = 3_000;

/** Sleep on an unref'd timer — never keeps a short-lived hook process alive. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

// ─── Start decision (M2a) ────────────────────────────────────────────────────

/** Age of the pidfile in ms, or null if it cannot be statted. */
function pidfileAgeMs(): number | null {
  try {
    return Date.now() - statSync(getSidecarPidPath()).mtimeMs;
  } catch {
    return null;
  }
}

export type SidecarStartDecision =
  | { action: "already-running" }
  | { action: "booting" }
  | { action: "start"; cleanedStale: boolean };

export interface StartAssessOptions {
  /** Reachability probe override (tests). Defaults to isSidecarReachable. */
  reachable?: () => Promise<boolean>;
  /** Booting-grace override (tests). Defaults to SIDECAR_BOOT_GRACE_MS. */
  graceMs?: number;
  /** Probe attempts before "wedged" (tests). Defaults to SIDECAR_PROBE_ATTEMPTS. */
  probeAttempts?: number;
  /** Delay between probe attempts (tests). Defaults to SIDECAR_PROBE_RETRY_DELAY_MS. */
  probeRetryDelayMs?: number;
}

/**
 * Decide whether a sidecar start should proceed:
 *
 * - reachable                           → already-running
 * - dead PID / no pidfile               → start (stale files cleaned)
 * - live-but-unreachable, young pidfile → booting (grace, see above)
 * - live-but-unreachable, old pidfile   → start (stale files cleaned)
 */
export async function assessSidecarStart(
  opts: StartAssessOptions = {},
): Promise<SidecarStartDecision> {
  const pid = readSidecarPid();
  if (pid === null) return { action: "start", cleanedStale: false };

  if (!isProcessAlive(pid)) {
    cleanupSidecarFiles();
    return { action: "start", cleanedStale: true };
  }

  const probe = opts.reachable ?? isSidecarReachable;
  if (await probe()) return { action: "already-running" };

  const age = pidfileAgeMs();
  const graceMs = opts.graceMs ?? SIDECAR_BOOT_GRACE_MS;
  if (age !== null && age < graceMs) return { action: "booting" };

  // Live PID past the boot grace but unreachable: a single failed probe is
  // not proof of a wedged sidecar — a healthy one whose event loop is
  // blocked >2s (in-process embedding of a large batch) fails one probe.
  // Retry before declaring it wedged and cleaning its files.
  const attempts = opts.probeAttempts ?? SIDECAR_PROBE_ATTEMPTS;
  const retryDelayMs = opts.probeRetryDelayMs ?? SIDECAR_PROBE_RETRY_DELAY_MS;
  for (let attempt = 1; attempt < attempts; attempt++) {
    await sleepUnref(retryDelayMs);
    if (await probe()) return { action: "already-running" };
  }

  cleanupSidecarFiles(pid);
  return { action: "start", cleanedStale: true };
}

// ─── Start lock (M2d) ────────────────────────────────────────────────────────

/** Path of the wx start lock, colocated with the sidecar pidfile. */
export function getSidecarStartLockPath(): string {
  return join(dirname(getSidecarPidPath()), "sidecar.start.lock");
}

/**
 * Take the exclusive start lock — `wx` create, mirroring the runtime_up
 * pidfile-claim pattern. EEXIST with a lock older than `staleMs` → stale
 * takeover (unlink + one wx retry; the retry's EEXIST closes the takeover
 * race). The lock is best-effort: if the lock MACHINERY fails (not
 * EEXIST), starting must not be blocked.
 */
function acquireStartLock(
  staleMs = START_LOCK_STALE_MS,
): "acquired" | "held" | "unavailable" {
  const lockPath = getSidecarStartLockPath();
  const tryWrite = (): boolean => {
    try {
      writeFileSync(lockPath, String(process.pid), {
        encoding: "utf-8",
        flag: "wx",
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw err;
    }
  };

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (tryWrite()) return "acquired";

    // EEXIST — another starter holds it. Stale takeover if old enough.
    // A LIVE starter keeps its lock's mtime fresh (guardStartLock), so
    // this only ever claims genuinely dead starters.
    let age: number | null = null;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      /* lock vanished between wx and stat — fall through to retry */
    }
    if (age !== null && age < staleMs) return "held";
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced with another takeover or the winner — retry decides */
    }
    return tryWrite() ? "acquired" : "held";
  } catch {
    return "unavailable";
  }
}

/** Unlink the start lock, but only if this process still owns it. */
function releaseStartLockIfOurs(lockPath: string): void {
  try {
    if (readFileSync(lockPath, "utf-8").trim() === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch {
    /* already gone, unreadable, or taken over — nothing to release */
  }
}

/**
 * Guard a held start lock while the spawned child boots: re-touch (utimes)
 * the lock every `touchIntervalMs` until the child's pidfile appears, so a
 * spawn-to-pidfile window longer than START_LOCK_STALE_MS (cold start,
 * loaded machine) can't let a second autoStart take over the lock and
 * double-spawn. Once the pidfile appears — or `maxMs` elapses — the lock is
 * released (if still ours).
 *
 * Detached (fire-and-forget) with unref'd timers: it must never delay a
 * caller nor keep a short-lived hook process alive. If this process exits,
 * the touching stops and the lock goes stale naturally — exactly the
 * dead-starter case takeover exists for.
 */
async function guardStartLock(opts: {
  touchIntervalMs: number;
  maxMs: number;
}): Promise<void> {
  // Capture paths up front: the guard outlives the call that spawned it and
  // must never follow a later path override (test mocks are restored while
  // a guard may still be draining).
  const lockPath = getSidecarStartLockPath();
  const pidPath = getSidecarPidPath();
  const deadline = Date.now() + opts.maxMs;

  while (Date.now() < deadline) {
    if (existsSync(pidPath)) break; // the child booted — done guarding
    try {
      const now = new Date();
      utimesSync(lockPath, now, now); // alive — keep the lock fresh
    } catch {
      return; // lock vanished (released or taken over) — stop guarding
    }
    await sleepUnref(opts.touchIntervalMs);
  }
  releaseStartLockIfOurs(lockPath);
}

// ─── Auto-start ──────────────────────────────────────────────────────────────

export type AutoStartOutcome =
  "started" | "already-running" | "booting" | "lock-held" | "unavailable";

export interface AutoStartDeps extends StartAssessOptions {
  /** Spawn override (tests). Return false to signal spawn failure. */
  spawnFn?: () => void | boolean;
  /** Start-lock staleness override (tests). */
  lockStaleMs?: number;
  /** Lock re-touch interval while the child boots (tests). */
  touchIntervalMs?: number;
  /** Upper bound on lock guarding (tests). */
  guardMaxMs?: number;
}

/** Default spawn: `sentinal sidecar start`, detached. */
function spawnSidecarStart(): boolean {
  try {
    const { findSentinalCmd } = require("../dashboard/lifecycle.js");
    const cmd: string[] | null = findSentinalCmd();
    if (!cmd) return false;
    Bun.spawn([...cmd, "sidecar", "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-start the sidecar if no reachable one exists. The full decision
 * (reachability, booting grace, stale-file cleanup, start lock) is
 * documented on assessSidecarStart / acquireStartLock.
 */
export async function autoStartSidecarAsync(
  deps: AutoStartDeps = {},
): Promise<AutoStartOutcome> {
  const decision = await assessSidecarStart(deps);
  if (decision.action !== "start") return decision.action;

  const lock = acquireStartLock(deps.lockStaleMs);
  if (lock === "held") return "lock-held";

  const spawn = deps.spawnFn ?? spawnSidecarStart;
  let spawned: boolean;
  try {
    spawned = spawn() !== false;
  } catch {
    spawned = false;
  }
  if (!spawned) return "unavailable";

  // Keep a LIVE starter's lock fresh while the child boots (detached).
  if (lock === "acquired") {
    void guardStartLock({
      touchIntervalMs: deps.touchIntervalMs ?? START_LOCK_TOUCH_INTERVAL_MS,
      maxMs: deps.guardMaxMs ?? START_LOCK_GUARD_MAX_MS,
    }).catch(() => {
      /* guarding is best-effort — takeover staleness still bounds it */
    });
  }
  return "started";
}

/**
 * Fire-and-forget wrapper kept SYNC so hook/MCP call sites need no change.
 * Non-fatal — callers should fall back to direct MemoryStore access.
 */
export function autoStartSidecar(): void {
  void autoStartSidecarAsync().catch(() => {
    /* non-fatal — sidecar is supplementary */
  });
}
