/**
 * Vector Store
 *
 * sqlite-vec integration for semantic search.
 * Manages vector embeddings alongside the main observations table.
 *
 * Uses the granular document model: each observation field (title, content, tag)
 * becomes a separate vector document for better retrieval precision.
 *
 * Gracefully degrades: if sqlite-vec or Homebrew SQLite is unavailable,
 * `isAvailable()` returns false and callers fall back to FTS5-only search.
 */

import { Database } from "bun:sqlite";
import { platform } from "node:os";
import { EmbeddingService } from "./embeddings.js";
import { EMBEDDING_CONSTANTS } from "./embeddings.js";
import { SEARCH_CONSTANTS } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorMetadata {
  observationId: number;
  fieldType: "title" | "content" | "tag";
  project: string;
  timestamp: number;
}

export interface VectorSearchOptions {
  limit?: number;
  project?: string;
  recencyWindowMs?: number;
}

export interface VectorResult {
  rowid: number;
  distance: number;
  observationId: number;
  fieldType: string;
  project: string;
  timestamp: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Raw row from sqlite-vec query (snake_case columns) */
interface RawVectorRow {
  rowid: number;
  distance: number;
  observation_id: number;
  field_type: string;
  project: string;
  timestamp: number;
}

/** Over-fetch multiplier for KNN when post-filtering is needed */
const KNN_OVERFETCH = 3;

const HOMEBREW_SQLITE_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // macOS ARM
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // macOS Intel
];

// ─── Initialization ───────────────────────────────────────────────────────────

let customSqliteLoaded = false;

/**
 * Attempt to load Homebrew SQLite for extension support.
 * Must be called BEFORE creating any Database instances.
 * Returns true if a custom SQLite was loaded.
 */
export function loadCustomSqlite(): boolean {
  if (customSqliteLoaded) return true;
  if (platform() !== "darwin") {
    // On Linux, system SQLite usually supports extensions
    // On Windows, user must provide their own
    customSqliteLoaded = true;
    return true;
  }

  for (const path of HOMEBREW_SQLITE_PATHS) {
    try {
      Database.setCustomSQLite(path);
      customSqliteLoaded = true;
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class VectorStore {
  private db: Database;
  private embeddings: EmbeddingService;
  private available = false;
  private initError: string | null = null;

  constructor(db: Database, embeddings: EmbeddingService) {
    this.db = db;
    this.embeddings = embeddings;
  }

  /**
   * Initialize the vector store: load sqlite-vec extension + create tables.
   * Must be called after construction. If it fails, the store degrades gracefully.
   */
  async initialize(): Promise<void> {
    try {
      const sqliteVec = await import("sqlite-vec");
      this.db.loadExtension(sqliteVec.getLoadablePath());
      this.createTables();
      this.available = true;
    } catch (error) {
      this.available = false;
      this.initError = error instanceof Error ? error.message : String(error);
    }
  }

  private createTables(): void {
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_vectors USING vec0(
        embedding float[${EMBEDDING_CONSTANTS.DIMENSIONS}],
        +observation_id INTEGER,
        +field_type TEXT,
        +project TEXT,
        +timestamp INTEGER
      )
    `);
  }

  /** Whether sqlite-vec is loaded and the vector table exists */
  isAvailable(): boolean {
    return this.available;
  }

  /** Error message if initialization failed */
  getInitError(): string | null {
    return this.initError;
  }

  // ─── Document Management ──────────────────────────────────────────────

  /**
   * Index an observation's fields as vector documents (granular model).
   * Creates separate vectors for title, content, and each tag.
   */
  async indexObservation(
    observationId: number,
    title: string,
    content: string,
    tags: string[],
    project: string,
    timestamp: number,
  ): Promise<number> {
    if (!this.available || !this.embeddings.isAvailable()) return 0;

    const texts: string[] = [title, content, ...tags];
    const fieldTypes: VectorMetadata["fieldType"][] = [
      "title",
      "content",
      ...tags.map(() => "tag" as const),
    ];

    const embeddings = await this.embeddings.embedBatch(texts);

    const stmt = this.db.prepare(`
      INSERT INTO observation_vectors(rowid, embedding, observation_id, field_type, project, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let indexed = 0;
    const baseRowid = observationId * 1000; // Reserve space: up to 1000 vectors per observation

    for (let i = 0; i < embeddings.length; i++) {
      const rowid = baseRowid + i;
      try {
        stmt.run(
          rowid,
          EmbeddingService.toBlob(embeddings[i]),
          observationId,
          fieldTypes[i],
          project,
          timestamp,
        );
        indexed++;
      } catch {
        // Skip duplicates on re-index
      }
    }

    return indexed;
  }

  /**
   * Remove all vector documents for an observation.
   */
  removeObservation(observationId: number): void {
    if (!this.available) return;

    // Delete all vectors in the reserved rowid range
    const baseRowid = observationId * 1000;
    this.db
      .prepare("DELETE FROM observation_vectors WHERE rowid >= ? AND rowid < ?")
      .run(baseRowid, baseRowid + 1000);
  }

  // ─── Search ───────────────────────────────────────────────────────────

  /**
   * Semantic KNN search. Returns observation IDs ranked by vector similarity.
   * Post-filters by project and recency since sqlite-vec doesn't support
   * WHERE on auxiliary columns during KNN queries.
   */
  async search(
    query: string,
    options: VectorSearchOptions = {},
  ): Promise<VectorResult[]> {
    if (!this.available || !this.embeddings.isAvailable()) return [];

    const limit = options.limit ?? SEARCH_CONSTANTS.DEFAULT_LIMIT;
    const queryEmbedding = await this.embeddings.embed(query);
    const queryBlob = EmbeddingService.toBlob(queryEmbedding);

    // Over-fetch to account for post-filtering
    const knnLimit =
      options.project || options.recencyWindowMs
        ? limit * KNN_OVERFETCH
        : limit;

    const rawRows = this.db
      .prepare(
        `SELECT rowid, distance, observation_id, field_type, project, timestamp
         FROM observation_vectors
         WHERE embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(queryBlob, knnLimit) as RawVectorRow[];

    const rows = rawRows.map(deserializeVectorRow);

    // Post-filter
    let filtered = rows;

    if (options.project) {
      filtered = filtered.filter((r) => r.project === options.project);
    }

    if (options.recencyWindowMs) {
      const cutoff = Date.now() - options.recencyWindowMs;
      filtered = filtered.filter((r) => r.timestamp > cutoff);
    }

    return filtered.slice(0, limit);
  }

  /**
   * Get the total number of vector documents indexed.
   */
  getVectorCount(): number {
    if (!this.available) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM observation_vectors")
      .get() as { count: number } | null;
    return row?.count ?? 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deserializeVectorRow(row: RawVectorRow): VectorResult {
  return {
    rowid: row.rowid,
    distance: row.distance,
    observationId: row.observation_id,
    fieldType: row.field_type,
    project: row.project,
    timestamp: row.timestamp,
  };
}
