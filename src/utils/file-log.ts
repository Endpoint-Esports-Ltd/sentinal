/**
 * File Logger Utility
 *
 * Shared, never-throwing file logger:
 * - Timestamped append to a named file under getLogDir()
 * - Size-capped rotation: when file exceeds maxBytes, rename to .1 (replacing
 *   any prior .1) and start a fresh file.
 * - readLastLines: return the last N non-empty lines from a file.
 *
 * node:* imports ONLY — hooks and SidecarClient import this transitively;
 * do NOT add bun:sqlite or any heavy dep.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Constants ───────────────────────────────────────────────────────────────

export const SIDECAR_LOG_FILE = "sidecar.log";
export const PLUGIN_LOG_FILE = "plugin.debug.log";

/** Default max file size before rotation (10 MB). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// ─── Path resolver ────────────────────────────────────────────────────────────

/**
 * Returns the directory where log files are written.
 * Exported as a real function so tests can `spyOn(fileLogModule, "getLogDir")`
 * to redirect writes to a temp dir — mirror of src/sidecar/paths.ts pattern.
 */
export function getLogDir(): string {
  return join(homedir(), ".sentinal");
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Rotate `filePath` → `filePath.1` (clobbering any prior backup) if the
 * current file size exceeds maxBytes.  Best-effort — never throws.
 */
function rotateIfNeeded(filePath: string, maxBytes: number): void {
  try {
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    if (size <= maxBytes) return;
    renameSync(filePath, filePath + ".1");
  } catch {
    /* non-fatal — lose the line, don't crash */
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a timestamped message to `<getLogDir()>/<fileName>`.
 * Rotates to `.1` first if the file exceeds maxBytes.
 * Never throws.
 */
export function logToFile(
  fileName: string,
  message: string,
  opts?: { maxBytes?: number },
): void {
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, fileName);
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    rotateIfNeeded(filePath, maxBytes);
    const ts = new Date().toISOString();
    appendFileSync(filePath, `${ts} ${message}\n`);
  } catch {
    /* non-fatal */
  }
}

/**
 * Append a timestamped message to sidecar.log.
 * Convenience wrapper used by sidecar server and SidecarClient.
 */
export function logSidecar(message: string): void {
  logToFile(SIDECAR_LOG_FILE, message);
}

/**
 * Return the last `n` non-empty lines from `filePath`.
 * Returns [] if the file does not exist.
 * Fine to read the whole file — rotation keeps it ≤ DEFAULT_MAX_BYTES.
 */
export function readLastLines(filePath: string, n: number): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}
