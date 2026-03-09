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
import { sanitizeObservationFields } from "./sanitize.js";

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

  // ─── Observations ─────────────────────────────────────────────────────

  addObservation(obs: CreateObservation): Observation {
    // Sanitize content before storage to strip secrets/credentials
    const sanitized = sanitizeObservationFields({ title: obs.title, content: obs.content });
    const cleanObs = sanitized.redactedCount > 0
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

    let observations: Observation[];

    if (!query || query.trim() === "") {
      observations = this.store.searchFilters(filters);
    } else {
      try {
        observations = this.store.searchFTS(
          sanitizeFtsQuery(query),
          filters,
        );
      } catch {
        observations = this.store.searchFilters(filters);
      }
    }

    return observations.map((obs) => toSearchResult(obs));
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

  startSession(projectPath: string, assistant: AssistantType, transcriptPath?: string): Session {
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
