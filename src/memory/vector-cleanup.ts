/**
 * Vector Row Cleanup
 *
 * The single shared primitive for removing an observation's vector rows from
 * `observation_vectors` (M6a of
 * docs/plans/2026-09-02-audit-medium-remediation.md). Every deletion path —
 * `VectorStore.removeObservation` (used by `MemoryService.deleteObservation`
 * and `updateObservation`) AND the batch prune paths in `MemoryStore` — must
 * go through this, otherwise pruned observations leave orphaned vector rows
 * that permanently consume KNN k-slots (hydration drops them, silently
 * shrinking semantic result sets) and bloat the table unboundedly.
 *
 * Kept dependency-free (no embeddings import) so `store.ts` can use it
 * without pulling in the vector/embedding stack.
 */

import type { Database } from "bun:sqlite";

/**
 * Rowid range reserved per observation in `observation_vectors`:
 * vectors for observation N live at rowids [N*1000, (N+1)*1000).
 * Must match `VectorStore.indexObservation`'s baseRowid scheme.
 */
export const VECTORS_PER_OBSERVATION = 1000;

/**
 * Best-effort delete of ALL vector rows for one observation id.
 *
 * Returns false (without throwing) when the delete cannot run — either the
 * `observation_vectors` table does not exist (vector stack never initialized
 * on this DB) or the vec0 module is not loaded on this connection (e.g. a
 * bare FTS-only CLI open against a DB whose vec table was created elsewhere;
 * a virtual table cannot be touched without its module). Callers proceed
 * with the observation delete either way — memory deletion must never fail
 * because vector cleanup can't run.
 */
export function deleteVectorRowsForObservation(
  db: Database,
  observationId: number,
): boolean {
  const base = observationId * VECTORS_PER_OBSERVATION;
  try {
    db.prepare(
      "DELETE FROM observation_vectors WHERE rowid >= ? AND rowid < ?",
    ).run(base, base + VECTORS_PER_OBSERVATION);
    return true;
  } catch {
    return false;
  }
}
