/**
 * Sidecar Lifecycle Manager
 *
 * Manages the sidecar server process via PID file.
 * Supports auto-start (lazy, on first hook/MCP invocation),
 * status checking, and graceful stop.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  getSidecarPidPath,
  getSidecarSocketPath,
  getSidecarPortPath,
} from "./paths.js";

// ─── PID helpers ─────────────────────────────────────────────────────────────

export function readSidecarPid(): number | null {
  const path = getSidecarPidPath();
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removeSidecarPid(): void {
  try {
    const path = getSidecarPidPath();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * Check if a process is alive via kill(pid, 0).
 * Exported for lifecycle-start.ts (the M2a/M2d start guard).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface SidecarStatus {
  running: boolean;
  pid: number | null;
  transport: "unix" | "http" | null;
}

/**
 * Check if the sidecar is currently running.
 * Cleans up stale PID files when the process is gone.
 */
export function isSidecarRunning(): boolean {
  const pid = readSidecarPid();
  if (pid === null) return false;
  if (isProcessAlive(pid)) return true;

  // Stale PID — clean up
  cleanupSidecarFiles();
  return false;
}

/**
 * Check if the sidecar is reachable by probing its HTTP endpoint.
 * More reliable than `isSidecarRunning()` because it verifies
 * the process is actually a sidecar (not a recycled PID).
 *
 * Returns false when neither a port nor a socket file exists — a bare
 * pidfile cannot be verified and must not count as reachable.
 */
export async function isSidecarReachable(): Promise<boolean> {
  const pid = readSidecarPid();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    cleanupSidecarFiles();
    return false;
  }

  // Try HTTP probe using the port file
  const portPath = getSidecarPortPath();
  if (existsSync(portPath)) {
    try {
      const content = readFileSync(portPath, "utf-8").trim();
      if (content && content !== "unix") {
        const port = parseInt(content, 10);
        if (!Number.isNaN(port)) {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          return res.ok;
        }
      }
    } catch {
      // Probe failed — process alive but not serving
      return false;
    }
  }

  // Try Unix socket probe (Bun-specific)
  const socketPath = getSidecarSocketPath();
  if (existsSync(socketPath)) {
    try {
      const res = await fetch("http://localhost/health", {
        unix: socketPath,
        signal: AbortSignal.timeout(2000),
      } as RequestInit);
      return res.ok;
    } catch {
      return false;
    }
  }

  // No port or socket file — cannot verify the process is a sidecar.
  // A real sidecar always writes its port file BEFORE the pidfile, so a
  // bare pidfile proves nothing; a PID-only fallback here would let a
  // recycled PID masquerade as "reachable" forever (M2a).
  return false;
}

/**
 * Get detailed sidecar status including transport mode.
 */
export function getSidecarStatus(): SidecarStatus {
  const pid = readSidecarPid();
  if (pid === null) return { running: false, pid: null, transport: null };

  if (!isProcessAlive(pid)) {
    cleanupSidecarFiles();
    return { running: false, pid: null, transport: null };
  }

  // Determine transport from port file
  let transport: "unix" | "http" | null = null;
  const portPath = getSidecarPortPath();
  if (existsSync(portPath)) {
    try {
      const content = readFileSync(portPath, "utf-8").trim();
      transport = content === "unix" ? "unix" : "http";
    } catch {
      /* ignore */
    }
  }

  return { running: true, pid, transport };
}

// ─── Start (M2a + M2d) — lives in lifecycle-start.ts (400-line rule) ────────

export {
  SIDECAR_BOOT_GRACE_MS,
  SIDECAR_PROBE_ATTEMPTS,
  SIDECAR_PROBE_RETRY_DELAY_MS,
  START_LOCK_STALE_MS,
  START_LOCK_TOUCH_INTERVAL_MS,
  START_LOCK_GUARD_MAX_MS,
  assessSidecarStart,
  getSidecarStartLockPath,
  autoStartSidecarAsync,
  autoStartSidecar,
  type SidecarStartDecision,
  type StartAssessOptions,
  type AutoStartOutcome,
  type AutoStartDeps,
} from "./lifecycle-start.js";

// ─── Stop (M2b: identity-checked) ────────────────────────────────────────────

/**
 * Argv of a live PID via `ps -p <pid> -o command=`, or null when ps fails
 * (dead PID, permission, missing ps). spawnSync keeps callers sync.
 * Portability: `command=` is POSIX and works on BSD/macOS + Linux
 * (no `etimes` — BSD ps lacks it).
 */
export function probeProcessCommand(pid: number): string | null {
  try {
    const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    if (res.exitCode !== 0) return null;
    const out = new TextDecoder().decode(res.stdout).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Marker every real sidecar spawn path produces (verified):
 * - autoStart:  `<sentinal|bun cli.ts> sidecar start`         (findSentinalCmd)
 * - CLI bg:     `<execPath|bun argv1> sidecar start [flags]`  (buildSpawnCmd)
 * - foreground: user-typed `sentinal sidecar start`
 * Consecutive-token match, so "bun test src/sidecar/x.test.ts" and other
 * paths merely CONTAINING "sidecar" do not match.
 */
const SIDECAR_ARGV_MARKER = /(^|\s)sidecar\s+start(\s|$)/;

/** Does this ps argv look like a sentinal sidecar process? */
export function looksLikeSidecarArgv(command: string): boolean {
  return SIDECAR_ARGV_MARKER.test(command);
}

export interface StopProbes {
  /** Identity probe override (tests). Defaults to probeProcessCommand. */
  identify?: (pid: number) => string | null;
}

/**
 * Stop the sidecar — but only after verifying the pidfile's PID is actually
 * a sentinal sidecar (M2b). Liveness alone proves nothing: the PID may have
 * been recycled onto an unrelated process, and unreachability is NOT proof
 * of death (a wedged sidecar is alive but not serving).
 *
 * - argv matches the sidecar marker → ours (serving OR wedged): SIGTERM,
 *   then clean files. Kept sync, so identity comes from the ps argv probe
 *   rather than an async /health pid match — for a serving sidecar the two
 *   agree, and a wedged one cannot answer /health anyway.
 * - argv is something else, or ps fails → recycled/unknown: clean the stale
 *   files so future starts aren't blocked, and do NOT signal.
 *
 * Returns true only when a verified sidecar was signalled.
 */
export function stopSidecarProcess(probes: StopProbes = {}): boolean {
  const pid = readSidecarPid();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    cleanupSidecarFiles();
    return false;
  }

  const identify = probes.identify ?? probeProcessCommand;
  let command: string | null = null;
  try {
    command = identify(pid);
  } catch {
    command = null;
  }
  if (command === null || !looksLikeSidecarArgv(command)) {
    // Recycled or unverifiable PID — never signal what we can't identify.
    cleanupSidecarFiles(pid);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    cleanupSidecarFiles(pid);
    return true;
  } catch {
    cleanupSidecarFiles(pid);
    return false;
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove all sidecar artifacts (PID, socket, port files).
 *
 * When `expectedPid` is provided, re-reads the PID file first and skips
 * cleanup if the file now contains a different PID (a newer sidecar took
 * ownership of the artifact files).
 *
 * Exported for lifecycle-start.ts (the M2a/M2d start guard).
 */
export function cleanupSidecarFiles(expectedPid?: number): void {
  if (expectedPid !== undefined) {
    const currentPid = readSidecarPid();
    if (currentPid !== null && currentPid !== expectedPid) {
      // A different sidecar owns these files — don't delete
      return;
    }
  }

  for (const path of [
    getSidecarPidPath(),
    getSidecarSocketPath(),
    getSidecarPortPath(),
  ]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
