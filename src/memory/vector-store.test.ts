/**
 * Vector Store Tests
 *
 * Tests sqlite-vec integration for semantic search.
 * These tests require Homebrew SQLite on macOS for extension loading.
 * They skip gracefully if sqlite-vec is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { VectorStore, loadCustomSqlite } from "./vector-store.js";
import { EmbeddingService } from "./embeddings.js";

// Try to load custom SQLite before any Database instances
const customSqliteAvailable = loadCustomSqlite();

describe("VectorStore", () => {
  let db: Database;
  let embeddings: EmbeddingService;
  let vectorStore: VectorStore;
  let available: boolean;

  beforeAll(async () => {
    embeddings = new EmbeddingService();
    await embeddings.initialize();

    db = new Database(":memory:");
    vectorStore = new VectorStore(db, embeddings);
    await vectorStore.initialize();
    available = vectorStore.isAvailable();

    if (!available) {
      console.warn(
        "VectorStore not available, skipping vector tests. Error:",
        vectorStore.getInitError(),
      );
    }
  });

  afterAll(() => {
    db.close();
  });

  describe("initialization", () => {
    it("should report availability status", () => {
      // Either available or not — we just check the API works
      expect(typeof vectorStore.isAvailable()).toBe("boolean");
    });

    it("should report init error when unavailable", () => {
      if (available) {
        expect(vectorStore.getInitError()).toBeNull();
      } else {
        expect(vectorStore.getInitError()).not.toBeNull();
      }
    });
  });

  describe("indexObservation", () => {
    it("should index observation fields as separate vectors", async () => {
      if (!available) return;

      const indexed = await vectorStore.indexObservation(
        1,
        "JWT authentication bug",
        "Token expired during refresh flow causing 401 errors",
        ["auth", "jwt"],
        "/test/project",
        Date.now(),
      );

      // title + content + 2 tags = 4 vectors
      expect(indexed).toBe(4);
      expect(vectorStore.getVectorCount()).toBe(4);
    });

    it("should index a second observation", async () => {
      if (!available) return;

      const indexed = await vectorStore.indexObservation(
        2,
        "Database migration added users table",
        "Created migration to add users table with email, name, created_at columns",
        ["database", "migration"],
        "/test/project",
        Date.now(),
      );

      expect(indexed).toBe(4);
      expect(vectorStore.getVectorCount()).toBe(8);
    });

    it("should return 0 when store is unavailable", async () => {
      if (available) return; // only test when unavailable

      const indexed = await vectorStore.indexObservation(
        99,
        "test",
        "test content",
        [],
        "/test",
        Date.now(),
      );
      expect(indexed).toBe(0);
    });
  });

  describe("search", () => {
    it("should find semantically similar observations", async () => {
      if (!available) return;

      const results = await vectorStore.search("authentication token");

      expect(results.length).toBeGreaterThan(0);
      // The auth-related observation should be closest
      const topResult = results[0];
      expect(topResult.observationId).toBe(1);
    });

    it("should find database-related observations", async () => {
      if (!available) return;

      const results = await vectorStore.search("database schema migration");

      expect(results.length).toBeGreaterThan(0);
      // Should find the database observation
      const obsIds = results.map((r) => r.observationId);
      expect(obsIds).toContain(2);
    });

    it("should respect limit parameter", async () => {
      if (!available) return;

      const results = await vectorStore.search("test", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should return empty when unavailable", async () => {
      if (available) return;

      const results = await vectorStore.search("anything");
      expect(results).toEqual([]);
    });
  });

  describe("search filtering", () => {
    it("should post-filter by project", async () => {
      if (!available) return;

      // Index an observation for a different project
      await vectorStore.indexObservation(
        3,
        "Auth token refresh for other project",
        "Similar auth content but different project",
        ["auth"],
        "/other/project",
        Date.now(),
      );

      const results = await vectorStore.search("authentication", {
        project: "/test/project",
      });

      for (const result of results) {
        expect(result.project).toBe("/test/project");
      }
    });

    it("should post-filter by recency window", async () => {
      if (!available) return;

      const now = Date.now();

      // Index an old observation
      await vectorStore.indexObservation(
        4,
        "Old auth observation",
        "Very old authentication issue",
        [],
        "/test/project",
        now - 200 * 24 * 60 * 60 * 1000, // 200 days ago
      );

      const results = await vectorStore.search("authentication", {
        recencyWindowMs: 90 * 24 * 60 * 60 * 1000, // 90 days
      });

      for (const result of results) {
        expect(result.timestamp).toBeGreaterThan(
          now - 90 * 24 * 60 * 60 * 1000,
        );
      }
    });
  });

  describe("removeObservation", () => {
    it("should remove vectors for an observation", async () => {
      if (!available) return;

      const countBefore = vectorStore.getVectorCount();
      vectorStore.removeObservation(1);
      const countAfter = vectorStore.getVectorCount();

      expect(countAfter).toBeLessThan(countBefore);
    });

    it("should be a no-op when unavailable", () => {
      if (available) return;

      // Should not throw
      vectorStore.removeObservation(999);
    });
  });
});
