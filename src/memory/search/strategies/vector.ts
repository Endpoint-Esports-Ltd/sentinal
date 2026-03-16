/**
 * Vector Strategy
 *
 * Pure semantic search via sqlite-vec. Finds observations by meaning
 * rather than keyword matching. Uses the granular document model where
 * each observation field is a separate vector.
 */

import type { MemoryStore } from "../../store.js";
import type { VectorStore } from "../../vector-store.js";
import type { SearchFilters, Observation } from "../../types.js";
import { SEARCH_CONSTANTS } from "../../types.js";
import type { SearchStrategy, ScoredObservation } from "./types.js";

export class VectorStrategy implements SearchStrategy {
  readonly name = "vector";
  private store: MemoryStore;
  private vectorStore: VectorStore;

  constructor(store: MemoryStore, vectorStore: VectorStore) {
    this.store = store;
    this.vectorStore = vectorStore;
  }

  async search(
    query: string,
    filters: SearchFilters,
  ): Promise<ScoredObservation[]> {
    const vectorResults = await this.vectorStore.search(query, {
      limit: filters.limit * 2, // Over-fetch for dedup
      project: filters.project,
      recencyWindowMs: SEARCH_CONSTANTS.RECENCY_WINDOW_MS,
    });

    if (vectorResults.length === 0) return [];

    // Deduplicate by observation_id (multiple vectors per observation)
    const bestByObservation = new Map<number, number>();
    for (const result of vectorResults) {
      const existing = bestByObservation.get(result.observationId);
      if (existing === undefined || result.distance < existing) {
        bestByObservation.set(result.observationId, result.distance);
      }
    }

    // Convert distance to similarity score (0-1, higher is better)
    const scored: Array<{ observationId: number; score: number }> = [];
    for (const [obsId, distance] of bestByObservation) {
      scored.push({
        observationId: obsId,
        score: 1 / (1 + distance), // Inverse distance
      });
    }

    // Sort by score descending and take top N
    scored.sort((a, b) => b.score - a.score);
    const topIds = scored.slice(0, filters.limit).map((s) => s.observationId);

    // Fetch full observations
    const observations = this.store.getObservations(topIds);
    const obsMap = new Map(observations.map((o) => [o.id, o]));

    // Apply additional filters (type, tags, date range)
    const results: ScoredObservation[] = [];
    for (const s of scored) {
      const obs = obsMap.get(s.observationId);
      if (!obs) continue;
      if (!passesFilters(obs, filters)) continue;
      results.push({ observation: obs, score: s.score });
      if (results.length >= filters.limit) break;
    }

    return results;
  }
}

function passesFilters(obs: Observation, filters: SearchFilters): boolean {
  if (filters.type && obs.type !== filters.type) return false;
  if (filters.types?.length && !filters.types.includes(obs.type)) return false;
  if (filters.dateStart && obs.timestamp < filters.dateStart) return false;
  if (filters.dateEnd && obs.timestamp > filters.dateEnd) return false;
  if (filters.tags?.length) {
    for (const tag of filters.tags) {
      if (!obs.tags.includes(tag)) return false;
    }
  }
  return true;
}
