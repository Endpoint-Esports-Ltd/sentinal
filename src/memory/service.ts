/**
 * Memory Service
 *
 * Business logic layer for the persistent memory system.
 * Orchestrates storage, search, and retrieval operations.
 *
 * Supports two modes:
 * - Simple: FTS-only search (no vector dependencies)
 * - Full: Hybrid search via SearchOrchestrator (vector + FTS + filters)
 */

import { randomUUID } from "node:crypto";
import { MemoryStore } from "./store.js";
import type { VectorStore } from "./vector-store.js";
import type { SearchOrchestrator } from "./search/orchestrator.js";
import type {
  Observation,
  CreateObservation,
  Session,
  SearchFilters,
  SearchResult,
  TimelineResult,
  TimelineEntry,
  MemoryStats,
  AssistantType,
} from "./types.js";
import { SEARCH_CONSTANTS, SearchFiltersSchema } from "./types.js";
import type { ObservationType } from "./types.js";
import { sanitizeObservationFields } from "./sanitize.js";
import { applyFreshness } from "./search/freshness.js";

export interface MemoryServiceOptions {
  store?: MemoryStore;
  vectorStore?: VectorStore;
  orchestrator?: SearchOrchestrator;
}

export class MemoryService {
  private store: MemoryStore;
  private vectorStore: VectorStore | null;
  private orchestrator: SearchOrchestrator | null;

  constructor(storeOrOptions?: MemoryStore | MemoryServiceOptions) {
    if (!storeOrOptions || storeOrOptions instanceof MemoryStore) {
      this.store = storeOrOptions ?? new MemoryStore();
      this.vectorStore = null;
      this.orchestrator = null;
    } else {
      this.store = storeOrOptions.store ?? new MemoryStore();
      this.vectorStore = storeOrOptions.vectorStore ?? null;
      this.orchestrator = storeOrOptions.orchestrator ?? null;
    }
  }

  /**
   * Late-inject vector search backends into the LIVE service instance.
   *
   * The sidecar initializes the vector stack in the background after
   * listening; routes capture `ctx.service`, so the existing instance is
   * mutated rather than replaced. After injection, `addObservation()`
   * auto-indexes vectors and `search()` routes through the orchestrator.
   */
  setSearchBackends(
    vectorStore: VectorStore,
    orchestrator: SearchOrchestrator,
  ): void {
    this.vectorStore = vectorStore;
    this.orchestrator = orchestrator;
  }

  // ─── Observations ─────────────────────────────────────────────────────

  addObservation(obs: CreateObservation): Observation {
    // Sanitize content before storage to strip secrets/credentials
    const sanitized = sanitizeObservationFields({
      title: obs.title,
      content: obs.content,
    });
    const cleanObs =
      sanitized.redactedCount > 0
        ? { ...obs, title: sanitized.title, content: sanitized.content }
        : obs;

    const inserted = this.store.insertObservation(cleanObs);

    // Auto-index vectors in background (non-blocking)
    if (this.vectorStore?.isAvailable()) {
      this.vectorStore
        .indexObservation(
          inserted.id,
          inserted.title,
          inserted.content,
          inserted.tags,
          inserted.projectPath,
          inserted.timestamp,
        )
        .catch(() => {
          /* Vector indexing failure is non-fatal */
        });
    }

    return inserted;
  }

  getObservation(id: number): Observation | null {
    return this.store.getObservation(id);
  }

  getObservations(ids: number[]): Observation[] {
    return this.store.getObservations(ids);
  }

  deleteObservation(id: number): boolean {
    const deleted = this.store.deleteObservation(id);
    if (deleted) {
      this.vectorStore?.removeObservation(id);
    }
    return deleted;
  }

  /**
   * Update an observation in place (correct/supersede it) and RESET its
   * staleness (timestamp + quality). Keeps BOTH indexes in sync: FTS via the
   * store's UPDATE trigger, and the VECTOR embedding by removing the old
   * document and re-indexing the new content (there is no in-place vector
   * update). Returns the updated observation, or null if `id` doesn't exist.
   */
  updateObservation(
    id: number,
    patch: {
      title?: string;
      content?: string;
      type?: ObservationType;
      tags?: string[];
      filePaths?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Observation | null {
    // Sanitize incoming title/content the same way addObservation does, so a
    // correction can't reintroduce secrets/credentials.
    let cleanPatch = patch;
    if (patch.title !== undefined || patch.content !== undefined) {
      const sanitized = sanitizeObservationFields({
        title: patch.title ?? "",
        content: patch.content ?? "",
      });
      if (sanitized.redactedCount > 0) {
        cleanPatch = {
          ...patch,
          ...(patch.title !== undefined ? { title: sanitized.title } : {}),
          ...(patch.content !== undefined
            ? { content: sanitized.content }
            : {}),
        };
      }
    }

    const updated = this.store.updateObservation(id, cleanPatch);
    if (!updated) return null;

    // Re-index the vector: remove the stale embedding, then add the new one.
    if (this.vectorStore?.isAvailable()) {
      this.vectorStore.removeObservation(id);
      this.vectorStore
        .indexObservation(
          updated.id,
          updated.title,
          updated.content,
          updated.tags,
          updated.projectPath,
          updated.timestamp,
        )
        .catch(() => {
          /* Vector re-indexing failure is non-fatal */
        });
    }

    return updated;
  }

  getRecentForProject(projectPath: string, limit?: number): Observation[] {
    return this.store.getRecentForProject(projectPath, limit);
  }

  // ─── Search (Layer 1: compact index) ──────────────────────────────────

  /**
   * Search memory. Uses the orchestrator (hybrid/vector/fts) if available,
   * otherwise falls back to simple FTS search.
   */
  async search(
    query: string,
    rawFilters?: Partial<SearchFilters>,
  ): Promise<SearchResult[]> {
    if (this.orchestrator) {
      return this.orchestrator.search(query, rawFilters);
    }

    return this.searchFtsOnly(query, rawFilters);
  }

  /** Synchronous FTS-only search (backward compatible) */
  searchSync(
    query: string,
    rawFilters?: Partial<SearchFilters>,
  ): SearchResult[] {
    return this.searchFtsOnly(query, rawFilters);
  }

  private searchFtsOnly(
    query: string,
    rawFilters?: Partial<SearchFilters>,
  ): SearchResult[] {
    const filters = SearchFiltersSchema.parse(rawFilters ?? {});

    // Explicit chronological ordering is passed straight through — no
    // freshness re-rank, so `date_asc`/`date_desc` are preserved exactly.
    if (filters.orderBy !== "relevance") {
      return this.ftsFetch(query, filters).map((obs) => toSearchResult(obs));
    }

    // Relevance mode: over-fetch a larger candidate set (bm25 order), then
    // re-rank by shared freshness (recency + quality) so a fresher/higher-
    // quality item ranked just past the caller's limit CAN surface.
    const candidateLimit = Math.max(filters.limit * 5, 50);
    const candidates = this.ftsFetch(query, {
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
  private ftsFetch(query: string, filters: SearchFilters): Observation[] {
    if (!query || query.trim() === "") {
      return this.store.searchFilters(filters);
    }
    try {
      return this.store.searchFTS(sanitizeFtsQuery(query), filters);
    } catch {
      return this.store.searchFilters(filters);
    }
  }

  // ─── Timeline (Layer 2: context around anchor) ────────────────────────

  timeline(
    anchor: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    projectPath?: string,
  ): TimelineResult {
    const {
      anchor: anchorObs,
      before,
      after,
    } = this.store.getTimelineAround(
      anchor,
      depthBefore,
      depthAfter,
      projectPath,
    );

    if (!anchorObs) {
      return { anchor, entries: [], totalBefore: 0, totalAfter: 0 };
    }

    const entries: TimelineEntry[] = [
      ...before.map((o) => toTimelineEntry(o, false)),
      toTimelineEntry(anchorObs, true),
      ...after.map((o) => toTimelineEntry(o, false)),
    ];

    return {
      anchor,
      entries,
      totalBefore: before.length,
      totalAfter: after.length,
    };
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  startSession(
    projectPath: string,
    assistant: AssistantType,
    transcriptPath?: string,
  ): Session {
    return this.store.insertSession({
      id: randomUUID(),
      startTime: Date.now(),
      endTime: null,
      projectPath,
      assistant,
      summary: null,
      transcriptPath: transcriptPath ?? null,
    });
  }

  endSession(sessionId: string, summary?: string): void {
    this.store.endSession(sessionId, summary);
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  getStats(): MemoryStats {
    return this.store.getStats();
  }

  /** Whether vector/hybrid search is available */
  isVectorAvailable(): boolean {
    return this.orchestrator?.isVectorAvailable() ?? false;
  }

  // ─── Maintenance ──────────────────────────────────────────────────────

  prune(olderThanMs: number): number {
    return this.store.prune(olderThanMs);
  }

  close(): void {
    this.store.close();
  }

  /** Expose underlying store for extensions */
  getStore(): MemoryStore {
    return this.store;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSearchResult(obs: Observation): SearchResult {
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

function toTimelineEntry(obs: Observation, isAnchor: boolean): TimelineEntry {
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
