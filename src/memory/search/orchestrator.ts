/**
 * Search Orchestrator
 *
 * Selects the appropriate search strategy based on:
 * - Whether a text query is provided
 * - Whether vector search is available
 * - Whether exact match is requested
 *
 * Graceful degradation hierarchy:
 *   hybrid → vector → fts → filter
 */

import type { MemoryStore } from "../store.js";
import type { VectorStore } from "../vector-store.js";
import type { SearchFilters, SearchResult } from "../types.js";
import { SEARCH_CONSTANTS, SearchFiltersSchema } from "../types.js";
import type { SearchStrategy, ScoredObservation } from "./strategies/types.js";
import { FilterStrategy } from "./strategies/filter.js";
import { FTSStrategy } from "./strategies/fts.js";
import { VectorStrategy } from "./strategies/vector.js";
import { HybridStrategy } from "./strategies/hybrid.js";

export class SearchOrchestrator {
  private store: MemoryStore;
  private vectorStore: VectorStore | null;
  private filterStrategy: FilterStrategy;
  private ftsStrategy: FTSStrategy;
  private vectorStrategy: VectorStrategy | null;
  private hybridStrategy: HybridStrategy | null;

  constructor(store: MemoryStore, vectorStore: VectorStore | null) {
    this.store = store;
    this.vectorStore = vectorStore;

    // Always-available strategies
    this.filterStrategy = new FilterStrategy(store);
    this.ftsStrategy = new FTSStrategy(store);

    // Vector-dependent strategies
    if (vectorStore?.isAvailable()) {
      this.vectorStrategy = new VectorStrategy(store, vectorStore);
      this.hybridStrategy = new HybridStrategy(store, vectorStore);
    } else {
      this.vectorStrategy = null;
      this.hybridStrategy = null;
    }
  }

  /**
   * Execute a search using the best available strategy.
   * Returns compact search results (Layer 1 of progressive disclosure).
   */
  async search(
    query: string,
    rawFilters?: Partial<SearchFilters>,
  ): Promise<SearchResult[]> {
    const filters = SearchFiltersSchema.parse(rawFilters ?? {});
    const strategy = this.selectStrategy(query, filters);
    const scored = await strategy.search(query, filters);

    return scored.map((s) => toSearchResult(s));
  }

  /**
   * Get the name of the strategy that would be used for a given query.
   * Useful for debugging and logging.
   */
  getStrategyName(query: string, rawFilters?: Partial<SearchFilters>): string {
    const filters = SearchFiltersSchema.parse(rawFilters ?? {});
    return this.selectStrategy(query, filters).name;
  }

  /** Whether vector/hybrid search is available */
  isVectorAvailable(): boolean {
    return this.hybridStrategy !== null;
  }

  private selectStrategy(
    query: string,
    filters: SearchFilters,
  ): SearchStrategy {
    // No query → metadata-only filtering
    if (!query || query.trim() === "") {
      return this.filterStrategy;
    }

    // Exact match requested → FTS only
    if (filters.exactMatch) {
      return this.ftsStrategy;
    }

    // Vector available → hybrid (best quality)
    if (this.hybridStrategy) {
      return this.hybridStrategy;
    }

    // Fallback → FTS keyword search
    return this.ftsStrategy;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSearchResult(scored: ScoredObservation): SearchResult {
  const obs = scored.observation;
  return {
    id: obs.id,
    title: obs.title,
    type: obs.type,
    timestamp: obs.timestamp,
    score: scored.score,
    estimatedTokens: Math.ceil(
      (obs.title.length + obs.content.length) /
        SEARCH_CONSTANTS.CHARS_PER_TOKEN_ESTIMATE,
    ),
    snippet: obs.content.slice(0, SEARCH_CONSTANTS.SNIPPET_LENGTH),
    tags: obs.tags,
    filePaths: obs.filePaths,
  };
}
