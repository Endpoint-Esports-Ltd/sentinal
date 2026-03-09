/**
 * Filter Strategy
 *
 * Metadata-only search: date range, type, project, tags.
 * Used when no text query is provided.
 */

import type { MemoryStore } from "../../store.js";
import type { SearchFilters } from "../../types.js";
import type { SearchStrategy, ScoredObservation } from "./types.js";

export class FilterStrategy implements SearchStrategy {
  readonly name = "filter";
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async search(
    _query: string,
    filters: SearchFilters,
  ): Promise<ScoredObservation[]> {
    const observations = this.store.searchFilters(filters);
    return observations.map((obs, index) => ({
      observation: obs,
      // Score by recency position (most recent = highest score)
      score: 1.0 - index * 0.01,
    }));
  }
}
