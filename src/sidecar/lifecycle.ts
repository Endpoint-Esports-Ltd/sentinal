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
} from "./server.js";

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
  } catch { /* ignore */ }
}

/**
 * Check if a process is alive via kill(pid, 0).
 */
function isProcessAlive(pid: number): boolean {
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
    } catch { /* ignore */ }
  }

  return { running: true, pid, transport };
}

// ─── Start ───────────────────────────────────────────────────────────────────

/**
 * Find the sentinal CLI binary. Prefers compiled global install,
 * falls back to running from source (development mode).
 */
function findSentinalBin(): string | null {
  const { join } = require("node:path");
  const { homedir } = require("node:os");
  const { DB_CONSTANTS } = require("../memory/types.js");

  const binPath = join(homedir(), DB_CONSTANTS.DB_DIR, "bin", "sentinal");
  if (existsSync(binPath)) return binPath;

  // Development mode: run from source
  try {
    const srcPath = join(__dirname, "..", "cli", "index.ts");
    if (existsSync(srcPath)) return srcPath;
  } catch { /* __dirname may not be available */ }

  return null;
}

/**
 * Auto-start the sidecar if not already running.
 * Spawns `sentinal sidecar start` as a detached background process.
 * Non-fatal — callers should fall back to direct MemoryStore access.
 */
export function autoStartSidecar(): void {
  if (isSidecarRunning()) return;

  try {
    const sentinalBin = findSentinalBin();
    if (!sentinalBin) return;

    Bun.spawn(["bun", sentinalBin, "sidecar", "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
  } catch {
    // Non-fatal — sidecar is supplementary
  }
}

// ─── Stop ────────────────────────────────────────────────────────────────────

/**
 * Stop the sidecar server by sending SIGTERM to the PID.
 * Returns true if the sidecar was running and was stopped.
 */
export function stopSidecarProcess(): boolean {
  const pid = readSidecarPid();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    cleanupSidecarFiles();
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    cleanupSidecarFiles();
    return true;
  } catch {
    cleanupSidecarFiles();
    return false;
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove all sidecar artifacts (PID, socket, port files).
 */
function cleanupSidecarFiles(): void {
  for (const path of [getSidecarPidPath(), getSidecarSocketPath(), getSidecarPortPath()]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }
  }
}
