/**
 * Auto-decay runner
 *
 * Throttled quality-score decay meant to run once on sidecar startup.
 * The sidecar boots roughly once per work-session, so gating on a
 * `last-decay.json` timestamp (default 24h) gives natural ~daily decay
 * with NO per-session hook and no cross-session loop.
 *
 * Everything here is best-effort: a missing/corrupt state file is treated
 * as "stale" (run), and any failure is swallowed so it can NEVER block or
 * crash sidecar startup.
 */

import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { MemoryStore } from "./store.js";
import { decayQualityScores } from "./maintenance.js";
import { getSentinalHome } from "./db-path.js";

/** Default throttle: run decay at most once per 24h. */
export const DEFAULT_DECAY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface AutoDecayOptions {
  /** Current time in ms — injectable for deterministic tests. */
  now?: number;
  /** Minimum time between decay runs. Defaults to 24h. */
  thresholdMs?: number;
  /** Path to the throttle state file. Defaults to ~/.sentinal/last-decay.json. */
  stateFile?: string;
}

export interface AutoDecayResult {
  ran: boolean;
  updated?: number;
}

/**
 * Default location of the throttle state file
 * (`$SENTINAL_HOME/last-decay.json`, D2 seam — defaults to
 * `~/.sentinal/last-decay.json`).
 * Overridable via `SENTINAL_LAST_DECAY_PATH` (used for isolated tests).
 */
export function getLastDecayPath(): string {
  return (
    process.env.SENTINAL_LAST_DECAY_PATH ??
    join(getSentinalHome(), "last-decay.json")
  );
}

function readLastDecay(stateFile: string): number | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as {
      lastDecay?: unknown;
    };
    return typeof parsed.lastDecay === "number" ? parsed.lastDecay : null;
  } catch {
    // Corrupt file → treat as stale so decay runs and rewrites it.
    return null;
  }
}

/**
 * Run `decayQualityScores` iff the throttle window has elapsed. Best-effort:
 * never throws. The row updates run inside a single transaction because
 * `decayQualityScores` issues O(N) per-row UPDATEs.
 */
export function runAutoDecayIfStale(
  store: MemoryStore,
  options: AutoDecayOptions = {},
): AutoDecayResult {
  const now = options.now ?? Date.now();
  const thresholdMs = options.thresholdMs ?? DEFAULT_DECAY_THRESHOLD_MS;
  const stateFile = options.stateFile ?? getLastDecayPath();

  try {
    const lastDecay = readLastDecay(stateFile);
    if (lastDecay !== null && now - lastDecay < thresholdMs) {
      return { ran: false };
    }

    // Wrap the O(N) per-row updates in a single transaction for efficiency.
    const db = store.getRawDb();
    const runDecay = db.transaction(() => decayQualityScores(store));
    const result = runDecay();

    // Record the run (create the state dir on fresh machines / CI).
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ lastDecay: now }, null, 2),
      "utf-8",
    );

    return { ran: true, updated: result.updated };
  } catch {
    // Best-effort — a decay failure must never affect the sidecar.
    return { ran: false };
  }
}
