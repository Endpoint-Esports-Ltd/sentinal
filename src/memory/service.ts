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
import type { ObservationType } from "./types.js";
import { sanitizeObservationFields } from "./sanitize.js";
import {
  addObservationDeduped,
  type DedupedObservationResult,
} from "./observation-dedupe.js";
import {
  ftsFetch,
  searchFtsOnly,
  toTimelineEntry,
} from "./observation-search.js";

export {
  AUTO_CAPTURE_DEDUP_WINDOW_MS,
  ERROR_DEDUP_WINDOW_MS,
  FIX_TITLE_DEDUP_WINDOW_MS,
  type DedupedObservationResult,
} from "./observation-dedupe.js";

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

  /**
   * Add an observation, de-duplicating repeats (D3 signed errors, D10
   * auto-captures).
   *
   * The signature is the client's `metadata.signature` for an error (D3), else
   * `computeDedupeSignature` — non-null only for auto-captures and
   * observations carrying `metadata.dedupeKey`. An existing row of the same
   * (project, type, signature) first seen within 30 min before
   * `obs.timestamp` — or, for an auto-captured `fix`, the same (project,
   * title) within 5 min — has its `occurrences` bumped (no insert, no
   * re-embed) and is returned with `deduplicated: true`. Otherwise the
   * observation is inserted, stamped with the signature and `occurrences: 1`.
   * Unsigned (manual) observations pass through unchanged.
   */
  addObservationDeduped(obs: CreateObservation): DedupedObservationResult {
    return addObservationDeduped(this.store, obs, (o) =>
      this.addObservation(o),
    );
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
    return searchFtsOnly(this.store, query, rawFilters);
  }

  /** Raw FTS/filter fetch (no freshness re-rank), honoring the given filters. */
  private ftsFetch(query: string, filters: SearchFilters): Observation[] {
    return ftsFetch(this.store, query, filters);
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
