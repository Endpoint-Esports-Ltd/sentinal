/**
 * Dashboard Server Lifecycle Manager
 *
 * Manages the dashboard server process via PID file.
 * Supports start detection, stop, and stale PID cleanup.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { DB_CONSTANTS } from "../memory/types.js";

const PID_FILE = "server.pid";

export function getPidFilePath(): string {
  return join(homedir(), DB_CONSTANTS.DB_DIR, PID_FILE);
}

export function writePidFile(pid: number): void {
  writeFileSync(getPidFilePath(), String(pid), "utf-8");
}

export function readPidFile(): number | null {
  const path = getPidFilePath();
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(getPidFilePath());
  } catch {
    // File may not exist — that's fine
  }
}

/**
 * Check if a process with the given PID is alive.
 * Uses `kill(pid, 0)` which doesn't send a signal but checks existence.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the dashboard server is currently running.
 * Handles stale PID files (process no longer exists).
 */
export function isServerRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;

  if (isProcessAlive(pid)) return true;

  // Stale PID file — process is gone, clean up
  removePidFile();
  return false;
}

/**
 * Auto-start the dashboard server if not already running.
 * Spawns `sentinal serve` as a detached background process.
 * Non-fatal — dashboard is supplementary.
 */
export function autoStartDashboard(): void {
  if (isServerRunning()) return;

  try {
    const cmd = findSentinalCmd();
    if (!cmd) return;
    Bun.spawn([...cmd, "serve"], {
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
  } catch {
    // Non-fatal — dashboard is supplementary
  }
}

/**
 * Find the sentinal CLI as a spawn-ready command array.
 * Compiled binary: ["/path/to/sentinal"]
 * Source/dev mode: ["bun", "/path/to/src/cli/index.ts"]
 */
export function findSentinalCmd(): string[] | null {
  const binPath = join(homedir(), DB_CONSTANTS.DB_DIR, "bin", "sentinal");
  if (existsSync(binPath)) return [binPath];

  // Fallback to src CLI (development mode — needs bun to run .ts)
  try {
    const srcPath = join(__dirname, "..", "cli", "index.ts");
    if (existsSync(srcPath)) return ["bun", srcPath];
  } catch {
    // __dirname may not be available in all contexts
  }

  return null;
}

/** @deprecated Use findSentinalCmd() instead */
export function findSentinalBin(): string | null {
  const cmd = findSentinalCmd();
  return cmd ? cmd[cmd.length - 1] : null;
}

/**
 * Stop the dashboard server by sending SIGTERM to the PID.
 * Returns true if the server was running and was stopped.
 */
export function stopServer(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    removePidFile();
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    removePidFile();
    return true;
  } catch {
    removePidFile();
    return false;
  }
}
