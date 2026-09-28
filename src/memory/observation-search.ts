/**
 * FTS-only search and result shaping for `MemoryService`.
 *
 * Split out of `service.ts` for length. The service's `searchFtsOnly` /
 * `ftsFetch` / `timeline` delegate here with its `MemoryStore`.
 */

import type { MemoryStore } from "./store.js";
import type {
  Observation,
  SearchFilters,
  SearchResult,
  TimelineEntry,
} from "./types.js";
import { SEARCH_CONSTANTS, SearchFiltersSchema } from "./types.js";
import { applyFreshness } from "./search/freshness.js";

/**
 * Simple FTS search: explicit chronological orders pass straight through;
 * relevance over-fetches and re-ranks by shared freshness.
 */
export function searchFtsOnly(
  store: MemoryStore,
  query: string,
  rawFilters?: Partial<SearchFilters>,
): SearchResult[] {
  const filters = SearchFiltersSchema.parse(rawFilters ?? {});

  // Explicit chronological ordering is passed straight through — no
  // freshness re-rank, so `date_asc`/`date_desc` are preserved exactly.
  if (filters.orderBy !== "relevance") {
    return ftsFetch(store, query, filters).map((obs) => toSearchResult(obs));
  }

  // Relevance mode: over-fetch a larger candidate set (bm25 order), then
  // re-rank by shared freshness (recency + quality) so a fresher/higher-
  // quality item ranked just past the caller's limit CAN surface.
  const candidateLimit = Math.max(filters.limit * 5, 50);
  const candidates = ftsFetch(store, query, {
    ...filters,
    limit: candidateLimit,
    offset: 0,
  });

  const now = Date.now();
  const ranked = candidates
    .map((obs, index) => ({
      obs,
      // Positional base score, mirroring FTSStrategy (`1 - index*0.05`).
      score: applyFreshness(1.0 - index * 0.05, obs, now),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked
    .slice(filters.offset, filters.offset + filters.limit)
    .map((r) => toSearchResult(r.obs));
}

/** Raw FTS/filter fetch (no freshness re-rank), honoring the given filters. */
export function ftsFetch(
  store: MemoryStore,
  query: string,
  filters: SearchFilters,
): Observation[] {
  if (!query || query.trim() === "") {
    return store.searchFilters(filters);
  }
  try {
    return store.searchFTS(sanitizeFtsQuery(query), filters);
  } catch {
    return store.searchFilters(filters);
  }
}

export function toSearchResult(obs: Observation): SearchResult {
  return {
    id: obs.id,
    title: obs.title,
    type: obs.type,
    timestamp: obs.timestamp,
    score: 0,
    estimatedTokens: Math.ceil(
      (obs.title.length + obs.content.length) /
        SEARCH_CONSTANTS.CHARS_PER_TOKEN_ESTIMATE,
    ),
    snippet: obs.content.slice(0, SEARCH_CONSTANTS.SNIPPET_LENGTH),
    tags: obs.tags,
    filePaths: obs.filePaths,
  };
}

export function toTimelineEntry(
  obs: Observation,
  isAnchor: boolean,
): TimelineEntry {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    timestamp: obs.timestamp,
    isAnchor,
    snippet: obs.content.slice(0, SEARCH_CONSTANTS.SNIPPET_LENGTH),
  };
}

function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(" ");
}
