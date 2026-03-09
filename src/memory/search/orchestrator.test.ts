/**
 * Search Orchestrator Tests
 *
 * Tests strategy selection, hybrid search, and graceful degradation.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { MemoryStore } from "../store.js";
import { VectorStore, loadCustomSqlite } from "../vector-store.js";
import { EmbeddingService } from "../embeddings.js";
import { SearchOrchestrator } from "./orchestrator.js";
import type { CreateObservation } from "../types.js";

// Load custom SQLite for extension support (must be before any Database)
loadCustomSqlite();

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "session-1",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "This is a test observation content",
    filePaths: [],
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("SearchOrchestrator", () => {
  let store: MemoryStore;
  let vectorStore: VectorStore;
  let embeddings: EmbeddingService;
  let orchestrator: SearchOrchestrator;
  let vectorAvailable: boolean;

  beforeAll(async () => {
    embeddings = new EmbeddingService();
    await embeddings.initialize();

    store = new MemoryStore(":memory:");

    // Get the raw DB for vector store
    const db = store.getRawDb();
    vectorStore = new VectorStore(db, embeddings);
    await vectorStore.initialize();
    vectorAvailable = vectorStore.isAvailable();

    orchestrator = new SearchOrchestrator(store, vectorStore);

    // Seed test data
    const obs1 = store.insertObservation(
      makeObservation({
        title: "JWT authentication token bug",
        content:
          "Token refresh fails when the access token expires during a concurrent request",
        type: "error",
        tags: ["auth", "jwt", "concurrency"],
        timestamp: Date.now() - 1000,
      }),
    );
    const obs2 = store.insertObservation(
      makeObservation({
        title: "Database migration for users table",
        content:
          "Created migration to add email verification columns to users table",
        type: "decision",
        tags: ["database", "migration"],
        timestamp: Date.now() - 2000,
      }),
    );
    const obs3 = store.insertObservation(
      makeObservation({
        title: "Angular signal pattern for forms",
        content:
          "Using computed signals for form validation provides better reactivity than RxJS",
        type: "pattern",
        tags: ["angular", "signals", "forms"],
        timestamp: Date.now() - 3000,
      }),
    );

    // Index vectors if available
    if (vectorAvailable) {
      for (const obs of [obs1, obs2, obs3]) {
        await vectorStore.indexObservation(
          obs.id,
          obs.title,
          obs.content,
          obs.tags,
          obs.projectPath,
          obs.timestamp,
        );
      }
    }
  });

  afterAll(() => {
    store.close();
  });

  describe("strategy selection", () => {
    it("should use filter strategy when query is empty", () => {
      expect(orchestrator.getStrategyName("")).toBe("filter");
      expect(orchestrator.getStrategyName("  ")).toBe("filter");
    });

    it("should use fts strategy for exact match requests", () => {
      expect(
        orchestrator.getStrategyName("test", { exactMatch: true }),
      ).toBe("fts");
    });

    it("should use hybrid when vector is available and query provided", () => {
      const name = orchestrator.getStrategyName("test query");
      if (vectorAvailable) {
        expect(name).toBe("hybrid");
      } else {
        expect(name).toBe("fts");
      }
    });
  });

  describe("search with no query (filter strategy)", () => {
    it("should return all observations ordered by recency", async () => {
      const results = await orchestrator.search("");

      expect(results.length).toBe(3);
      // Most recent first
      expect(results[0].timestamp).toBeGreaterThanOrEqual(
        results[1].timestamp,
      );
    });

    it("should filter by type", async () => {
      const results = await orchestrator.search("", { type: "error" });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe("JWT authentication token bug");
    });

    it("should filter by tags", async () => {
      const results = await orchestrator.search("", {
        tags: ["angular"],
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe("Angular signal pattern for forms");
    });
  });

  describe("search with query (FTS or hybrid)", () => {
    it("should find observations by keyword", async () => {
      const results = await orchestrator.search("authentication");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toContain("authentication");
    });

    it("should find observations by content keyword", async () => {
      const results = await orchestrator.search("migration");

      expect(results.length).toBeGreaterThanOrEqual(1);
      const titles = results.map((r) => r.title);
      expect(titles).toContain("Database migration for users table");
    });

    it("should include score in results", async () => {
      const results = await orchestrator.search("authentication");

      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it("should include estimated tokens", async () => {
      const results = await orchestrator.search("authentication");

      for (const result of results) {
        expect(result.estimatedTokens).toBeGreaterThan(0);
      }
    });

    it("should include snippet", async () => {
      const results = await orchestrator.search("authentication");

      for (const result of results) {
        expect(result.snippet.length).toBeGreaterThan(0);
        expect(result.snippet.length).toBeLessThanOrEqual(201);
      }
    });
  });

  describe("search with filters + query", () => {
    it("should combine keyword search with type filter", async () => {
      const results = await orchestrator.search("migration", {
        type: "decision",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        expect(result.type).toBe("decision");
      }
    });
  });

  describe("graceful degradation", () => {
    it("should work without vector store", async () => {
      const ftsOnlyOrchestrator = new SearchOrchestrator(store, null);

      expect(ftsOnlyOrchestrator.isVectorAvailable()).toBe(false);
      expect(ftsOnlyOrchestrator.getStrategyName("test")).toBe("fts");

      const results = await ftsOnlyOrchestrator.search("authentication");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle FTS query errors gracefully", async () => {
      // FTS special characters should not crash
      const results = await orchestrator.search('AND OR NOT "unclosed');
      // Should still return results (falls back to filter)
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
