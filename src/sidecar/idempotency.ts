/**
 * Idempotency for destructive sidecar routes (issue #9).
 *
 * A destructive `worktree_cleanup` completed server-side, the CLIENT timed out
 * at 30s, and the caller — told the operation had "failed" — retried it twice.
 * That is the correct human and agent response to a reported failure, and it is
 * why a destructive endpoint must not depend on the caller getting the answer.
 *
 * With an `idempotency_key`, a repeat within the TTL REPLAYS the first result
 * instead of re-executing. The caller learns what the original call actually
 * did, which is precisely what the timeout denied them.
 *
 * ⛔ Deliberately built on `MemoryStore.getSetting/setSetting` rather than a new
 * table: the sidecar restarts (60s idle shutdown), so an in-memory cache would
 * be lost in exactly the window where a retry arrives. The settings table is
 * already durable, already migrated, and already the mechanism used for
 * version-scoped backoff keys in `self-heal.ts`.
 */

import type { MemoryStore } from "../memory/store.js";

/**
 * How long a recorded outcome is replayable.
 *
 * Sized for "a caller who was told the outcome was unknown comes back to check"
 * — minutes, not days. A long TTL would turn a legitimately-repeated cleanup
 * (e.g. a nightly job reusing a key) into a silent no-op.
 */
export const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/** Settings-table key. Namespaced per operation so ids cannot cross over. */
function recordKey(operation: string, key: string): string {
  return `idem:${operation}:${key}`;
}

export interface IdempotentOutcome<T> {
  result: T;
  /** True when this is a replay of an earlier identical request. */
  replayed: boolean;
}

interface StoredRecord {
  at: number;
  result: unknown;
}

/**
 * Run `op` at most once per (operation, key) within {@link IDEMPOTENCY_TTL_MS}.
 *
 * With no key the operation simply runs — callers that make no idempotency
 * claim get exactly the previous behaviour.
 *
 * ⛔ A THROWN operation is never recorded. Caching a failure would make a
 * transient git error permanent for the whole TTL, and the caller could not
 * retry their way out of it.
 */
export function withIdempotency<T>(
  store: MemoryStore,
  operation: string,
  key: string | undefined,
  op: () => T,
): IdempotentOutcome<T> {
  if (!key) return { result: op(), replayed: false };

  const k = recordKey(operation, key);
  const replay = readRecord<T>(store, k);
  if (replay) return replay;

  const result = op();
  record(store, k, result);
  return { result, replayed: false };
}

/**
 * Async counterpart of {@link withIdempotency}.
 *
 * ⛔ Needed because `abandon` stops an owned process group before removing the
 * directory, and is therefore async — the sync wrapper would record the
 * *promise*, not the outcome, and would record it before the work had either
 * succeeded or failed.
 */
export async function withIdempotencyAsync<T>(
  store: MemoryStore,
  operation: string,
  key: string | undefined,
  op: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  if (!key) return { result: await op(), replayed: false };

  const k = recordKey(operation, key);
  const replay = readRecord<T>(store, k);
  if (replay) return replay;

  // Awaited BEFORE recording: a rejected operation must stay retryable.
  const result = await op();
  record(store, k, result);
  return { result, replayed: false };
}

/** Return a live (non-expired) recorded outcome, or null. */
function readRecord<T>(
  store: MemoryStore,
  k: string,
): IdempotentOutcome<T> | null {
  const raw = store.getSetting(k);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as StoredRecord;
    if (Date.now() - rec.at <= IDEMPOTENCY_TTL_MS) {
      return { result: rec.result as T, replayed: true };
    }
  } catch {
    // Corrupt record — re-execute. Refusing to act because a cache entry is
    // malformed would be worse than doing the work twice.
  }
  return null;
}

function record(store: MemoryStore, k: string, result: unknown): void {
  try {
    store.setSetting(k, JSON.stringify({ at: Date.now(), result }));
  } catch {
    // Best-effort: failing to RECORD must never fail an operation that has
    // already succeeded — that is the very inversion this issue is about.
  }
}
