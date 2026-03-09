/**
 * Embedding Service
 *
 * Generates text embeddings using Transformers.js (Xenova/all-MiniLM-L6-v2).
 * Produces 384-dimensional vectors for semantic search via sqlite-vec.
 *
 * Gracefully degrades: if the model can't load, `isAvailable()` returns false
 * and callers fall back to FTS5-only search.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { DB_CONSTANTS } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const EMBEDDING_CONSTANTS = {
  MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
  DIMENSIONS: 384,
  MAX_TOKENS: 512,
  /** Truncate text to roughly this many chars before embedding */
  MAX_TEXT_LENGTH: 2000,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type Pipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

// ─── Service ──────────────────────────────────────────────────────────────────

export class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private initPromise: Promise<void> | null = null;
  private available = false;
  private initError: string | null = null;

  /**
   * Lazily initialize the embedding pipeline.
   * Call this before `embed()` or `embedBatch()`, or they will call it automatically.
   */
  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Dynamic import to allow graceful degradation
      const { pipeline, env } = await import("@xenova/transformers");

      // Configure transformers.js cache directory
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      env.useBrowserCache = false;
      env.cacheDir = join(homedir(), DB_CONSTANTS.DB_DIR, "models");

      this.pipeline = await pipeline(
        "feature-extraction",
        EMBEDDING_CONSTANTS.MODEL_NAME,
      ) as unknown as Pipeline;
      this.available = true;
    } catch (error) {
      this.available = false;
      this.initError =
        error instanceof Error ? error.message : String(error);
      this.pipeline = null;
    }
  }

  /** Whether the embedding model is loaded and ready */
  isAvailable(): boolean {
    return this.available;
  }

  /** Error message if initialization failed */
  getInitError(): string | null {
    return this.initError;
  }

  /**
   * Generate an embedding for a single text.
   * Returns a Float32Array of EMBEDDING_CONSTANTS.DIMENSIONS length.
   * Throws if the service is not available.
   */
  async embed(text: string): Promise<Float32Array> {
    await this.initialize();
    if (!this.pipeline) {
      throw new Error(
        `Embedding service unavailable: ${this.initError ?? "unknown error"}`,
      );
    }

    const truncated = text.slice(0, EMBEDDING_CONSTANTS.MAX_TEXT_LENGTH);
    const output = await this.pipeline(truncated, {
      pooling: "mean",
      normalize: true,
    });

    return new Float32Array(output.data);
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * More efficient than calling embed() repeatedly.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    await this.initialize();
    if (!this.pipeline) {
      throw new Error(
        `Embedding service unavailable: ${this.initError ?? "unknown error"}`,
      );
    }

    // Process individually since Transformers.js batch API
    // can have inconsistent output shapes
    const results: Float32Array[] = [];
    for (const text of texts) {
      const truncated = text.slice(0, EMBEDDING_CONSTANTS.MAX_TEXT_LENGTH);
      const output = await this.pipeline(truncated, {
        pooling: "mean",
        normalize: true,
      });
      results.push(new Float32Array(output.data));
    }

    return results;
  }

  /**
   * Convert a Float32Array embedding to a Uint8Array blob for sqlite-vec storage.
   */
  static toBlob(embedding: Float32Array): Uint8Array {
    return new Uint8Array(embedding.buffer);
  }

  /**
   * Convert a Uint8Array blob from sqlite-vec back to Float32Array.
   */
  static fromBlob(blob: Uint8Array): Float32Array {
    return new Float32Array(blob.buffer);
  }
}
