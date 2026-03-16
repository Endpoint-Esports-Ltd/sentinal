/**
 * Offline Observation Queue
 *
 * Buffers observation payloads to disk when the sidecar is unavailable.
 * Drains lazily when the sidecar reconnects (plugin init or session.created).
 *
 * Queue file: ~/.sentinal/observation-queue.json
 * Format: JSON array of observation payloads (each has projectPath, sessionId)
 * Cap: 50 entries (global). Oldest dropped when exceeded.
 *
 * Node.js-compatible — no bun:sqlite, no Zod, no SidecarClient import.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const QUEUE_DIR = join(homedir(), ".sentinal");
const QUEUE_FILE = "observation-queue.json";
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

/** Exported for test mocking via spyOn */
export function getQueuePath(): string {
  return join(QUEUE_DIR, QUEUE_FILE);
}

function readQueue(): QueuedObservation[] {
  const queuePath = getQueuePath();
  if (!existsSync(queuePath)) return [];
  try {
    const raw = readFileSync(queuePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    // Corrupted file — start fresh
    return [];
  }
}

function writeQueue(entries: QueuedObservation[]): void {
  const queuePath = getQueuePath();
  const dir = dirname(queuePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(queuePath, JSON.stringify(entries), "utf-8");
}

export const ObservationQueue = {
  /**
   * Append an observation to the queue file.
   * If the queue exceeds MAX_QUEUE_SIZE, oldest entries are dropped.
   */
  enqueue(payload: QueuedObservation, log?: LogFn): void {
    const queue = readQueue();
    queue.push(payload);

    if (queue.length > MAX_QUEUE_SIZE) {
      const dropped = queue.length - MAX_QUEUE_SIZE;
      queue.splice(0, dropped);
      log?.(
        `observation queue: dropped ${dropped} oldest entries (cap ${MAX_QUEUE_SIZE})`,
      );
    }

    writeQueue(queue);
  },

  /**
   * Drain queued observations by calling sendFn for each.
   * Successfully sent entries are removed. Failed entries remain.
   * Returns counts: { sent, failed, remaining }.
   */
  async drain(
    sendFn: (obs: QueuedObservation) => Promise<void>,
    log?: LogFn,
  ): Promise<{ sent: number; failed: number; remaining: number }> {
    const queue = readQueue();
    if (queue.length === 0) return { sent: 0, failed: 0, remaining: 0 };

    const failed: QueuedObservation[] = [];
    let sent = 0;

    for (const obs of queue) {
      try {
        await sendFn(obs);
        sent++;
      } catch (e) {
        log?.(
          `queue drain: failed to send "${obs.title}": ${e instanceof Error ? e.message : e}`,
        );
        failed.push(obs);
      }
    }

    writeQueue(failed);
    log?.(`observation queue: drained ${sent} sent, ${failed.length} failed`);

    return { sent, failed: failed.length, remaining: failed.length };
  },

  /**
   * Return the number of pending observations, optionally filtered by project.
   */
  pending(projectPath?: string): number {
    const queue = readQueue();
    if (!projectPath) return queue.length;
    return queue.filter((e) => e.projectPath === projectPath).length;
  },
};
