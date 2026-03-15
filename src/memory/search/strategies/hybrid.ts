/**
 * Hybrid Strategy
 *
 * Combined vector similarity + FTS5 keyword search.
 * Uses weighted scoring: vector_score * 0.7 + fts_score * 0.3
 * with a recency boost for recent observations.
 *
 * This is the default strategy when both vector search and FTS are available.
 */

import type { MemoryStore } from "../../store.js";
import type { VectorStore } from "../../vector-store.js";
import type { SearchFilters, Observation } from "../../types.js";
import { SEARCH_CONSTANTS } from "../../types.js";
import { VectorStrategy } from "./vector.js";
import { FTSStrategy } from "./fts.js";
import type { SearchStrategy, ScoredObservation } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VECTOR_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;

/** Max recency boost (added to score for very recent observations) */
const MAX_RECENCY_BOOST = 0.1;

export class HybridStrategy implements SearchStrategy {
  readonly name = "hybrid";
  private vectorStrategy: VectorStrategy;
  private ftsStrategy: FTSStrategy;

  constructor(store: MemoryStore, vectorStore: VectorStore) {
    this.vectorStrategy = new VectorStrategy(store, vectorStore);
    this.ftsStrategy = new FTSStrategy(store);
  }

  async search(
    query: string,
    filters: SearchFilters,
  ): Promise<ScoredObservation[]> {
    // Run both searches in parallel
    const [vectorResults, ftsResults] = await Promise.all([
      this.vectorStrategy.search(query, {
        ...filters,
        limit: filters.limit * 2, // Over-fetch for merging
      }),
      this.ftsStrategy.search(query, {
        ...filters,
        limit: filters.limit * 2,
      }),
    ]);

    return mergeAndRank(vectorResults, ftsResults, filters.limit);
  }
}

// ─── Merge & Rank ─────────────────────────────────────────────────────────────

export function mergeAndRank(
  vectorResults: ScoredObservation[],
  ftsResults: ScoredObservation[],
  limit: number,
): ScoredObservation[] {
  // Build score maps by observation ID
  const vectorScores = new Map<number, ScoredObservation>();
  for (const r of vectorResults) {
    vectorScores.set(r.observation.id, r);
  }

  const ftsScores = new Map<number, ScoredObservation>();
  for (const r of ftsResults) {
    ftsScores.set(r.observation.id, r);
  }

  // Collect all unique observation IDs
  const allIds = new Set<number>([
    ...vectorScores.keys(),
    ...ftsScores.keys(),
  ]);

  // Compute combined scores
  const merged: ScoredObservation[] = [];
  const now = Date.now();

  for (const id of allIds) {
    const vectorEntry = vectorScores.get(id);
    const ftsEntry = ftsScores.get(id);
    const obs = vectorEntry?.observation ?? ftsEntry!.observation;

    const vectorScore = vectorEntry?.score ?? 0;
    const ftsScore = ftsEntry?.score ?? 0;

    // Weighted combination
    let combinedScore = vectorScore * VECTOR_WEIGHT + ftsScore * FTS_WEIGHT;

    // Recency boost: linear decay over 90-day window
    const age = now - obs.timestamp;
    if (age < SEARCH_CONSTANTS.RECENCY_WINDOW_MS) {
      const recencyFactor =
        1 - age / SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
      combinedScore += recencyFactor * MAX_RECENCY_BOOST;
    }

    // Quality score weighting: prioritize high-quality observations
    combinedScore *= Math.max(obs.qualityScore ?? 1.0, 0.1);

    merged.push({ observation: obs, score: combinedScore });
  }

  // Sort by combined score descending
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, limit);
}
