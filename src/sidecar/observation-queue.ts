/**
 * Offline Observation Queue (M11 — dir-as-queue)
 *
 * Buffers observation payloads to disk when the sidecar is unavailable.
 * Drains lazily when the sidecar reconnects (plugin init or session.created).
 *
 * Layout: `$SENTINAL_HOME/observation-queue/` — ONE file per observation.
 *  - enqueue = a single `wx`-flagged file create (atomic by construction);
 *    a concurrent drain or a second enqueueing process can never overwrite it
 *    (the old single-file read→modify→write spool lost exactly those).
 *  - drain = list entries (name-sorted = FIFO), send each, unlink on
 *    success, leave on failure. Entries created mid-drain are simply not in
 *    the listing and survive untouched.
 *  - entry names: zero-padded ms timestamp + per-process sequence + random
 *    suffix → lexicographic sort is chronological, same-ms unique.
 *
 * Legacy migration: the pre-M11 single-file spool
 * (`$SENTINAL_HOME/observation-queue.json`, a JSON array) is claimed via an
 * atomic rename, split into individual entry files, and deleted — once.
 *
 * Cap: 50 entries (global). Oldest (by name sort) dropped when exceeded.
 *
 * Node.js-compatible — no bun:sqlite, no Zod, no SidecarClient import.
 * (`db-path.ts` is node:* + types only — hook/plugin safe.)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { getSentinalHome } from "../memory/db-path.js";

const QUEUE_DIR_NAME = "observation-queue";
const LEGACY_QUEUE_FILE = "observation-queue.json";
const MAX_QUEUE_SIZE = 50;

/** Observation payload shape (matches SidecarClient.addObservation parameter) */
export interface QueuedObservation {
  sessionId: string;
  projectPath: string;
  type: string;
  title: string;
  content: string;
  filePaths?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

type LogFn = (msg: string) => void;

/** Legacy single-file spool path (pre-dir format) — migration source only. */
export function getQueuePath(): string {
  return join(getSentinalHome(), LEGACY_QUEUE_FILE);
}

/** The queue directory: one JSON file per pending observation. */
export function getQueueDir(): string {
  return join(getSentinalHome(), QUEUE_DIR_NAME);
}

// Per-process monotonic sequence — makes same-millisecond enqueues sort in
// insertion order (the random suffix alone would shuffle them).
let entrySeq = 0;

function nextEntryName(): string {
  const ts = String(Date.now()).padStart(15, "0");
  const seq = String(entrySeq++ % 1_000_000).padStart(6, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${seq}-${rand}.json`;
}

/** Entry files, name-sorted (= FIFO). [] on any error. */
function listEntryFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Atomically create one entry file (`wx`: fails if the name exists).
 * Retries with a fresh name on the (astronomically rare) collision.
 * Best-effort — returns false instead of throwing on an unwritable dir.
 */
function writeEntry(dir: string, obs: QueuedObservation): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(join(dir, nextEntryName()), JSON.stringify(obs), {
        encoding: "utf-8",
        flag: "wx",
      });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      return false;
    }
  }
  return false;
}

/**
 * One-time legacy migration: claim the old single-file spool via atomic
 * rename (a concurrent migrator loses the rename and skips), ingest its
 * entries as individual files, delete it. Corrupt spool → dropped.
 */
function migrateLegacySpool(dir: string, log?: LogFn): void {
  const legacyPath = getQueuePath();
  if (!existsSync(legacyPath)) return;
  const claimed = `${legacyPath}.migrating-${process.pid}`;
  try {
    renameSync(legacyPath, claimed);
  } catch {
    return; // someone else claimed it, or it vanished — nothing to do
  }
  try {
    const data: unknown = JSON.parse(readFileSync(claimed, "utf-8"));
    if (Array.isArray(data)) {
      let migrated = 0;
      for (const obs of data as QueuedObservation[]) {
        if (writeEntry(dir, obs)) migrated++;
      }
      log?.(
        `observation queue: migrated ${migrated} legacy spool entries to dir format`,
      );
    }
  } catch {
    // Corrupt legacy spool — drop it (matches the old "start fresh" behaviour)
  }
  try {
    unlinkSync(claimed);
  } catch {
    /* best-effort */
  }
}

/**
 * Ensure the queue dir exists and the legacy spool is migrated.
 * Returns null when the dir cannot be created (e.g. HOME=/) — callers
 * degrade to a silent no-op, matching the old best-effort contract.
 */
function ensureQueueDir(log?: LogFn): string | null {
  const dir = getQueueDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  migrateLegacySpool(dir, log);
  return dir;
}

function readEntry(path: string): QueuedObservation | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object"
      ? (data as QueuedObservation)
      : null;
  } catch {
    return null;
  }
}

export const ObservationQueue = {
  /**
   * Enqueue an observation as a single atomic file create.
   * If the queue exceeds MAX_QUEUE_SIZE, oldest entries are dropped.
   */
  enqueue(payload: QueuedObservation, log?: LogFn): void {
    const dir = ensureQueueDir(log);
    if (!dir) return; // unwritable — best-effort drop
    writeEntry(dir, payload);

    const files = listEntryFiles(dir);
    if (files.length > MAX_QUEUE_SIZE) {
      const doomed = files.slice(0, files.length - MAX_QUEUE_SIZE);
      let dropped = 0;
      for (const f of doomed) {
        try {
          unlinkSync(join(dir, f));
          dropped++;
        } catch {
          /* already gone (concurrent drain) — fine */
        }
      }
      log?.(
        `observation queue: dropped ${dropped} oldest entries (cap ${MAX_QUEUE_SIZE})`,
      );
    }
  },

  /**
   * Drain queued observations by calling sendFn for each (FIFO).
   * Successfully sent entries are unlinked. Failed entries remain on disk.
   * Entries enqueued while a drain is running are untouched (picked up by
   * the next drain). Returns counts: { sent, failed, remaining }.
   */
  async drain(
    sendFn: (obs: QueuedObservation) => Promise<void>,
    log?: LogFn,
  ): Promise<{ sent: number; failed: number; remaining: number }> {
    const dir = ensureQueueDir(log);
    if (!dir) return { sent: 0, failed: 0, remaining: 0 };

    const files = listEntryFiles(dir);
    if (files.length === 0) return { sent: 0, failed: 0, remaining: 0 };

    let sent = 0;
    let failed = 0;

    for (const f of files) {
      const path = join(dir, f);
      const obs = readEntry(path);
      if (!obs) {
        // Corrupt or vanished entry — drop it so it can't wedge every drain.
        try {
          unlinkSync(path);
        } catch {
          /* best-effort */
        }
        continue;
      }
      try {
        await sendFn(obs);
        sent++;
        try {
          unlinkSync(path);
        } catch {
          /* best-effort — worst case it is re-sent next drain */
        }
      } catch (e) {
        failed++;
        log?.(
          `queue drain: failed to send "${obs.title}": ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    log?.(`observation queue: drained ${sent} sent, ${failed} failed`);
    return { sent, failed, remaining: failed };
  },

  /**
   * Return the number of pending observations, optionally filtered by project.
   */
  pending(projectPath?: string): number {
    const dir = ensureQueueDir();
    if (!dir) return 0;
    const files = listEntryFiles(dir);
    if (!projectPath) return files.length;
    let count = 0;
    for (const f of files) {
      const obs = readEntry(join(dir, f));
      if (obs?.projectPath === projectPath) count++;
    }
    return count;
  },
};
