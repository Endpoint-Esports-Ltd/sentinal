/**
 * Search Strategy Interface
 *
 * All search strategies implement this interface, allowing the orchestrator
 * to swap between vector, FTS, hybrid, and filter strategies transparently.
 */

import type { SearchFilters, SearchResult, Observation } from "../../types.js";

export interface SearchStrategy {
  readonly name: string;
  search(query: string, filters: SearchFilters): Promise<ScoredObservation[]>;
}

/** Observation with a relevance score attached by the search strategy */
export interface ScoredObservation {
  observation: Observation;
  score: number;
}
