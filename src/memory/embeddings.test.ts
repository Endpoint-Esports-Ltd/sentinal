/**
 * Embedding Service Tests
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { EmbeddingService, EMBEDDING_CONSTANTS } from "./embeddings.js";

describe("EmbeddingService", () => {
  let service: EmbeddingService;

  beforeAll(async () => {
    service = new EmbeddingService();
    await service.initialize();
  });

  describe("initialization", () => {
    it("should be available after initialization", () => {
      expect(service.isAvailable()).toBe(true);
      expect(service.getInitError()).toBeNull();
    });

    it("should only initialize once even with multiple calls", async () => {
      const service2 = new EmbeddingService();
      await Promise.all([service2.initialize(), service2.initialize()]);
      expect(service2.isAvailable()).toBe(true);
    });
  });

  describe("embed", () => {
    it("should produce a 384-dimensional vector", async () => {
      const embedding = await service.embed("Hello world");

      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(EMBEDDING_CONSTANTS.DIMENSIONS);
    });

    it("should produce normalized vectors (unit length)", async () => {
      const embedding = await service.embed("Test normalization");

      // L2 norm should be ~1.0 for normalized vectors
      let norm = 0;
      for (const val of embedding) {
        norm += val * val;
      }
      norm = Math.sqrt(norm);

      expect(norm).toBeCloseTo(1.0, 2);
    });

    it("should produce similar embeddings for similar texts", async () => {
      const emb1 = await service.embed("JWT authentication token expired");
      const emb2 = await service.embed("Auth token has expired");
      const emb3 = await service.embed("Database migration schema update");

      const sim12 = cosineSimilarity(emb1, emb2);
      const sim13 = cosineSimilarity(emb1, emb3);

      // Similar texts should have higher similarity than unrelated texts
      expect(sim12).toBeGreaterThan(sim13);
    });

    it("should handle long text by truncating", async () => {
      const longText = "word ".repeat(2000);
      const embedding = await service.embed(longText);

      expect(embedding.length).toBe(EMBEDDING_CONSTANTS.DIMENSIONS);
    });
  });

  describe("embedBatch", () => {
    it("should return empty array for empty input", async () => {
      const results = await service.embedBatch([]);
      expect(results).toEqual([]);
    });

    it("should embed multiple texts", async () => {
      const texts = [
        "First document about testing",
        "Second document about deployment",
        "Third document about monitoring",
      ];

      const results = await service.embedBatch(texts);

      expect(results).toHaveLength(3);
      for (const emb of results) {
        expect(emb).toBeInstanceOf(Float32Array);
        expect(emb.length).toBe(EMBEDDING_CONSTANTS.DIMENSIONS);
      }
    });
  });

  describe("blob conversion", () => {
    it("should round-trip Float32Array through blob", async () => {
      const embedding = await service.embed("Test blob conversion");
      const blob = EmbeddingService.toBlob(embedding);
      const restored = EmbeddingService.fromBlob(blob);

      expect(restored.length).toBe(embedding.length);
      for (let i = 0; i < embedding.length; i++) {
        expect(restored[i]).toBeCloseTo(embedding[i], 6);
      }
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
