/**
 * Dashboard ensure + binary version helpers for the OpenCode plugin.
 *
 * ⛔ These live in src/ (NOT exported from targets/opencode/plugins/
 * sentinal.ts) because OpenCode invokes EVERY function export of a plugin
 * module as a plugin factory with PluginInput and pushes the return values
 * into its hooks array (upstream getLegacyPlugins). Exporting helpers from
 * the plugin module caused three production incidents on 2026-06-10:
 * a hard plugin-load failure ("stdout.trim is not a function" — the helper
 * was invoked with PluginInput), null/undefined hooks crashing later hook
 * triggers, and a spurious dashboard ensure per instance (the doubled
 * "dashboard ensure" log lines since v1.31.0).
 *
 * Do NOT import bun:sqlite (or anything pulling it in) here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { logToFile, PLUGIN_LOG_FILE } from "../utils/file-log.js";

const SENTINAL_DIR = join(homedir(), ".sentinal");

function log(message: string): void {
  logToFile(PLUGIN_LOG_FILE, message);
}

/**
 * Validate `sentinal --version` stdout. Only bare MAJOR.MINOR.PATCH
 * (optionally with prerelease/build suffix) is a version; a mid-update
 * binary once printed the literal string "undefined". Input is treated as
 * UNKNOWN and this function never throws.
 */
export function parseBinaryVersion(stdout: string): string | null {
  let s: string;
  if (typeof stdout === "string") {
    s = stdout;
  } else if (stdout == null) {
    return null;
  } else {
    try {
      s = String(stdout);
    } catch {
      return null;
    }
  }
  const trimmed = s.trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(trimmed)
    ? trimmed
    : null;
}

/**
 * Read the installed binary's version string (e.g. "1.31.4"). Cached after
 * first call. Synchronous spawn keeps every throw inside this frame.
 */
let _cachedBinaryVersion: string | null | undefined = undefined; // undefined = not yet fetched; null = fetch failed
export async function getBinaryVersion(): Promise<string | null> {
  if (_cachedBinaryVersion !== undefined) return _cachedBinaryVersion;
  const binPath = join(SENTINAL_DIR, "bin", "sentinal");
  if (!existsSync(binPath)) {
    _cachedBinaryVersion = null;
    return null;
  }
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
    });
    _cachedBinaryVersion = parseBinaryVersion(result.stdout as string);
    return _cachedBinaryVersion;
  } catch {
    _cachedBinaryVersion = null; // cache the failure — don't retry every call
    return null;
  }
}

/** Test hook: reset the version cache between tests. */
export function resetBinaryVersionCache(): void {
  _cachedBinaryVersion = undefined;
}

export interface EnsureDashboardOptions {
  currentVersion: string;
  probeFn?: () => Promise<{ version?: string; pid?: number } | null>;
  spawnFn?: () => void;
}

/**
 * Ensure the dashboard is running at the current version.
 * - If health probe returns null → spawn
 * - If running at a different version → spawn (idempotent serve handles takeover)
 * - If running at same version → skip
 * Never throws.
 */
export async function ensureDashboard(
  opts: EnsureDashboardOptions,
): Promise<void> {
  const probe = opts.probeFn ?? defaultDashboardProbe;
  const spawnDashboard = opts.spawnFn ?? defaultDashboardSpawn;
  try {
    const health = await probe();
    if (health && health.version === opts.currentVersion) {
      log(
        `dashboard ensure: already running version=${health.version} pid=${health.pid ?? "unknown"}`,
      );
      return;
    }
    if (health && health.version) {
      log(
        `dashboard ensure: version mismatch (running=${health.version} current=${opts.currentVersion}) — respawning`,
      );
    } else {
      log("dashboard ensure: not running — spawning");
    }
    spawnDashboard();
  } catch (err) {
    log(
      `dashboard ensure: error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function defaultDashboardProbe(): Promise<{
  version?: string;
  pid?: number;
} | null> {
  try {
    const resp = await fetch("http://127.0.0.1:41778/api/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { version?: string; pid?: number };
  } catch {
    return null;
  }
}

function defaultDashboardSpawn(): void {
  const binPath = join(SENTINAL_DIR, "bin", "sentinal");
  if (!existsSync(binPath)) return;
  const c = spawn(binPath, ["serve", "--background"], {
    stdio: "ignore",
    detached: true,
  });
  c.unref();
}
