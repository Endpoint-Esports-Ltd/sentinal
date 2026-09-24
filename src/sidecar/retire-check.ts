/**
 * Sidecar Binary Staleness Detection (retire-check)
 *
 * Answers, cheaply and repeatedly: "has the installed sentinal binary been
 * replaced by a DIFFERENT version than the one this sidecar is running?"
 * The sidecar's shutdown interval (server.ts) polls `check()` and retires
 * when it reports stale.
 *
 * Two stages, so the common case costs one stat():
 *   1. Snapshot `mtimeMs` of the installed binary at construction. Each poll
 *      re-stats it; an unchanged mtime is "not stale" with NO spawn.
 *   2. Only when the mtime changed, spawn `<bin> --version` once (async — the
 *      poll runs inside the sidecar's interval, so a blocking spawnSync
 *      would stall it) and compare against the running version.
 *
 * State machine after a changed mtime:
 *   - different parseable version → STALE, and LATCHED: every later check
 *     returns the same stale result without stat/spawn. The sidecar is
 *     about to retire; flapping back to "fresh" on a rollback would only
 *     make that decision racy.
 *   - same version (reinstall / touch) → not stale; the mtime snapshot is
 *     ADVANCED so the next tick does not re-spawn.
 *   - spawn failure / unparseable output (a mid-update binary once printed
 *     the literal "undefined") → not stale; the snapshot is NOT advanced,
 *     so the next tick re-probes once the install has settled.
 *
 * Gates (checked before any I/O):
 *   - Compiled binary only (`__SENTINAL_VERSION__` build define, overridable
 *     via `forceCompiled`). ⚠️ Polarity: production sidecars ARE compiled,
 *     so the check is ACTIVE there; source/dev runs are inactive because a
 *     source-run version vs installed-binary skew is expected noise.
 *   - `SENTINAL_NO_AUTO_RETIRE=1` kill switch (read fresh on every check),
 *     mirroring SENTINAL_NO_AUTO_SETUP in self-heal.ts.
 *
 * Never throws: any stat/spawn/parse failure means "not stale".
 *
 * Paths: uses getSentinalBinPath() (honours SENTINAL_HOME) — NOT update.ts's
 * BIN_PATH, which hardcodes homedir(). Deliberately does NOT use
 * getBinaryVersion(): it caches permanently, defeating the purpose here.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import {
  getSentinalBinPath,
  parseBinaryVersion,
} from "../opencode/dashboard-ensure.js";
import { getSentinalVersion } from "./version.js";

declare const __SENTINAL_VERSION__: string | undefined;

/** Budget for one `--version` probe. Matches getBinaryVersion()'s 3s. */
const PROBE_TIMEOUT_MS = 3_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BinaryStalenessOptions {
  /** Installed binary to watch. Default: getSentinalBinPath(), read once. */
  binPath?: string;
  /** Version this process is running. Default: getSentinalVersion(). */
  runningVersion?: string;
  /** Return the file's mtimeMs; may throw (treated as "missing"). */
  statter?: (path: string) => number;
  /** Run `<path> --version` and resolve with raw stdout; may reject. */
  versionProber?: (path: string) => Promise<string>;
  /** Test override for the compiled-binary gate. */
  forceCompiled?: boolean;
}

export interface StalenessResult {
  /** True only when a changed binary reported a different parseable version. */
  stale: boolean;
  runningVersion: string;
  /** Set when stale — the version the replaced binary reported. */
  installedVersion?: string;
}

export interface BinaryStalenessChecker {
  /** Whether the compiled gate allows checking at all (fixed at construction). */
  readonly active: boolean;
  /** The binary path being watched (fixed at construction). */
  readonly binPath: string;
  /** Poll once. Never rejects. Concurrent calls share one in-flight check. */
  check(): Promise<StalenessResult>;
}

// ─── Default seams ───────────────────────────────────────────────────────────

const defaultStatter = (path: string): number => statSync(path).mtimeMs;

const defaultVersionProber = (path: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stdout);
    };
    const child = spawn(path, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(new Error(`--version timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) =>
      finish(code === 0 ? null : new Error(`--version exited ${code}`)),
    );
  });

function safeStat(
  statter: (path: string) => number,
  path: string,
): number | null {
  try {
    const m = statter(path);
    return typeof m === "number" && Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a staleness checker holding a boot-time mtime snapshot. Call once at
 * sidecar start, then `check()` on each shutdown-interval tick.
 */
export function detectBinaryStaleness(
  opts: BinaryStalenessOptions = {},
): BinaryStalenessChecker {
  const active =
    opts.forceCompiled ?? typeof __SENTINAL_VERSION__ !== "undefined";
  const binPath = opts.binPath ?? getSentinalBinPath();
  const runningVersion = opts.runningVersion ?? getSentinalVersion();
  const statter = opts.statter ?? defaultStatter;
  const prober = opts.versionProber ?? defaultVersionProber;

  const fresh: StalenessResult = Object.freeze({
    stale: false,
    runningVersion,
  });
  // Inactive checkers never touch the filesystem, not even for the snapshot.
  let snapshot: number | null = active ? safeStat(statter, binPath) : null;
  let latched: StalenessResult | null = null;
  let inFlight: Promise<StalenessResult> | null = null;

  async function runCheck(): Promise<StalenessResult> {
    const mtime = safeStat(statter, binPath);
    // Missing binary (mid-update) or unchanged → not stale, no spawn.
    if (mtime === null || mtime === snapshot) return fresh;

    let installed: string | null;
    try {
      installed = parseBinaryVersion(await prober(binPath));
    } catch {
      return fresh; // snapshot kept → re-probe next tick
    }
    if (installed === null) return fresh; // unparseable → re-probe next tick

    if (installed === runningVersion) {
      snapshot = mtime; // same version reinstalled — don't re-spawn every tick
      return fresh;
    }
    latched = { stale: true, runningVersion, installedVersion: installed };
    return latched;
  }

  return {
    active,
    binPath,
    check(): Promise<StalenessResult> {
      if (!active) return Promise.resolve(fresh);
      if (process.env.SENTINAL_NO_AUTO_RETIRE === "1") {
        return Promise.resolve(fresh);
      }
      if (latched) return Promise.resolve(latched);
      if (inFlight) return inFlight;
      inFlight = runCheck()
        .catch(() => fresh)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
