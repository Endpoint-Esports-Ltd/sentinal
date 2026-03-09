/**
 * FTS Strategy
 *
 * SQLite FTS5 keyword search. Used as the fallback when vector search
 * is unavailable, or when the user requests exact keyword matching.
 */

import type { MemoryStore } from "../../store.js";
import type { SearchFilters } from "../../types.js";
import type { SearchStrategy, ScoredObservation } from "./types.js";

export class FTSStrategy implements SearchStrategy {
  readonly name = "fts";
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async search(
    query: string,
    filters: SearchFilters,
  ): Promise<ScoredObservation[]> {
    const ftsQuery = sanitizeFtsQuery(query);

    try {
      const observations = this.store.searchFTS(ftsQuery, filters);
      return observations.map((obs, index) => ({
        observation: obs,
        // FTS rank-based score, normalized to 0-1 range
        score: 1.0 - index * 0.05,
      }));
    } catch {
      // FTS query syntax error — fall back to filter search
      const observations = this.store.searchFilters(filters);
      return observations.map((obs, index) => ({
        observation: obs,
        score: 1.0 - index * 0.01,
      }));
    }
  }
}

/**
 * Sanitize user query for FTS5 syntax.
 * Wraps each term in quotes for prefix matching and escapes special chars.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(" ");
}
