/**
 * Observation Vector Backfill
 *
 * After vector search initializes, index observations that have no vector
 * documents yet (saved while the sidecar was down or before vector search
 * shipped). Processes ONE observation at a time with a pacing delay so the
 * sidecar event loop stays responsive — hooks need <100ms responses.
 */

import type { MemoryStore } from "./store.js";
import type { VectorStore } from "./vector-store.js";

export interface BackfillResult {
  /** Observations found without vectors */
  scanned: number;
  /** Observations successfully indexed */
  indexed: number;
}

export interface BackfillOptions {
  /** Pause between observations in ms (default 25). Use 0 to disable. */
  delayMs?: number;
}

/** Inter-observation pacing delay — keeps the event loop free for hooks. */
const DEFAULT_DELAY_MS = 25;

/** Rowid scheme from vector-store.ts: observationId * 1000 + fieldIndex. */
const ROWID_RESERVED_RANGE = 1000;

/**
 * Index all observations that have no vectors yet. Idempotent: already
 * indexed observations are excluded by the NOT IN query, so a second run
 * is a no-op.
 */
export async function backfillVectors(
  store: MemoryStore,
  vectorStore: VectorStore,
  log?: (msg: string) => void,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  if (!vectorStore.isAvailable()) {
    return { scanned: 0, indexed: 0 };
  }

  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const ids = findUnindexedObservationIds(store);
  log?.(`sidecar: vector backfill started (${ids.length} unindexed)`);

  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const obs = store.getObservation(ids[i]);
    if (!obs) continue;
    try {
      const count = await vectorStore.indexObservation(
        obs.id,
        obs.title,
        obs.content,
        obs.tags,
        obs.projectPath,
        obs.timestamp,
      );
      if (count > 0) indexed++;
    } catch {
      // One bad observation must not abort the whole backfill
      failed++;
    }
  }

  log?.(
    `sidecar: vector backfill complete (indexed ${indexed} of ${ids.length}` +
      `${failed > 0 ? `, ${failed} failed` : ""})`,
  );
  return { scanned: ids.length, indexed };
}

/**
 * Find observation IDs with no vector documents.
 *
 * Primary path: DISTINCT over the vec0 auxiliary column `observation_id`.
 * Fallback: derive observation IDs from the reserved rowid scheme
 * (rowid = observationId * 1000 + i) if the aux-column query misbehaves.
 */
function findUnindexedObservationIds(store: MemoryStore): number[] {
  const db = store.getRawDb();
  try {
    const rows = db
      .prepare(
        `SELECT id FROM observations
         WHERE id NOT IN (SELECT DISTINCT observation_id FROM observation_vectors)`,
      )
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  } catch {
    const rows = db
      .prepare(
        `SELECT id FROM observations
         WHERE id NOT IN (SELECT DISTINCT rowid / ${ROWID_RESERVED_RANGE} FROM observation_vectors)`,
      )
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }
}
