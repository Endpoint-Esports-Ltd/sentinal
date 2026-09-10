/**
 * Memory Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";
import type { VectorStore } from "./vector-store.js";
import type { SearchOrchestrator } from "./search/orchestrator.js";
import type { CreateObservation, SearchResult } from "./types.js";

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
    filePaths: ["src/test.ts"],
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

describe("MemoryService", () => {
  let service: MemoryService;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
  });

  describe("addObservation", () => {
    it("should add and return an observation", () => {
      const obs = service.addObservation(makeObservation());

      expect(obs.id).toBeGreaterThan(0);
      expect(obs.title).toBe("Test observation");
    });
  });

  describe("getObservation", () => {
    it("should retrieve an observation by ID", () => {
      const added = service.addObservation(makeObservation());
      const retrieved = service.getObservation(added.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(added.id);
    });

    it("should return null for non-existent ID", () => {
      expect(service.getObservation(999)).toBeNull();
    });
  });

  describe("getObservations (batch)", () => {
    it("should retrieve multiple observations", () => {
      const obs1 = service.addObservation(makeObservation({ title: "First" }));
      const obs2 = service.addObservation(makeObservation({ title: "Second" }));

      const results = service.getObservations([obs1.id, obs2.id]);
      expect(results).toHaveLength(2);
    });
  });

  describe("searchSync (FTS-only mode)", () => {
    it("should return results for keyword search", () => {
      service.addObservation(
        makeObservation({
          title: "JWT authentication",
          content: "Token handling",
        }),
      );
      service.addObservation(
        makeObservation({
          title: "Database migration",
          content: "Schema update",
        }),
      );

      const results = service.searchSync("authentication");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe("JWT authentication");
    });

    it("should return all observations when query is empty", () => {
      service.addObservation(makeObservation({ title: "First" }));
      service.addObservation(makeObservation({ title: "Second" }));

      const results = service.searchSync("");
      expect(results).toHaveLength(2);
    });

    it("should filter by type", () => {
      service.addObservation(
        makeObservation({ type: "decision", title: "Chose Angular" }),
      );
      service.addObservation(
        makeObservation({ type: "error", title: "Build failed" }),
      );

      const results = service.searchSync("", { type: "decision" });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Chose Angular");
    });

    it("should include estimated tokens in results", () => {
      service.addObservation(
        makeObservation({ title: "Short", content: "Brief" }),
      );

      const results = service.searchSync("Short");
      expect(results[0].estimatedTokens).toBeGreaterThan(0);
    });

    it("should include snippet in results", () => {
      service.addObservation(
        makeObservation({
          content: "A very long content that should be truncated",
        }),
      );

      const results = service.searchSync("");
      expect(results[0].snippet.length).toBeLessThanOrEqual(201); // SNIPPET_LENGTH + 1
    });
  });

  describe("search (async, FTS-only without orchestrator)", () => {
    it("should return results for keyword search", async () => {
      service.addObservation(
        makeObservation({
          title: "JWT authentication",
          content: "Token handling",
        }),
      );

      const results = await service.search("authentication");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe("JWT authentication");
    });

    it("should return all observations when query is empty", async () => {
      service.addObservation(makeObservation({ title: "First" }));
      service.addObservation(makeObservation({ title: "Second" }));

      const results = await service.search("");
      expect(results).toHaveLength(2);
    });
  });

  describe("timeline", () => {
    it("should return context around an anchor observation", () => {
      service.addObservation(
        makeObservation({ timestamp: 100, title: "Before" }),
      );
      const anchor = service.addObservation(
        makeObservation({ timestamp: 200, title: "Anchor" }),
      );
      service.addObservation(
        makeObservation({ timestamp: 300, title: "After" }),
      );

      const result = service.timeline(anchor.id, 10, 10);

      expect(result.anchor).toBe(anchor.id);
      expect(result.entries.length).toBe(3);

      const anchorEntry = result.entries.find((e) => e.isAnchor);
      expect(anchorEntry).toBeDefined();
      expect(anchorEntry!.title).toBe("Anchor");
    });

    it("should return empty entries for non-existent anchor", () => {
      const result = service.timeline(999);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe("sessions", () => {
    it("should start and end a session", () => {
      const session = service.startSession("/test/project", "claude-code");
      expect(session.id).toBeTruthy();
      expect(session.assistant).toBe("claude-code");
      expect(session.endTime).toBeNull();

      service.endSession(session.id, "Completed some work");
    });
  });

  describe("stats", () => {
    it("should return memory statistics", () => {
      service.addObservation(makeObservation({ type: "decision" }));
      service.addObservation(makeObservation({ type: "fix" }));

      const stats = service.getStats();
      expect(stats.totalObservations).toBe(2);
      expect(stats.byType.decision).toBe(1);
      expect(stats.byType.fix).toBe(1);
    });
  });

  describe("setSearchBackends", () => {
    function makeMockBackends() {
      const indexCalls: unknown[][] = [];
      const vectorStore = {
        isAvailable: () => true,
        indexObservation: (...args: unknown[]) => {
          indexCalls.push(args);
          return Promise.resolve(3);
        },
        removeObservation: () => {},
      } as unknown as VectorStore;

      const sentinel: SearchResult[] = [
        {
          id: 42,
          title: "From orchestrator",
          type: "discovery",
          timestamp: Date.now(),
          score: 0.9,
          estimatedTokens: 5,
          snippet: "orchestrator result",
          tags: [],
          filePaths: [],
        },
      ];
      const searchCalls: unknown[][] = [];
      const orchestrator = {
        search: (...args: unknown[]) => {
          searchCalls.push(args);
          return Promise.resolve(sentinel);
        },
        isVectorAvailable: () => true,
      } as unknown as SearchOrchestrator;

      return { vectorStore, orchestrator, indexCalls, searchCalls, sentinel };
    }

    it("routes search() through the injected orchestrator", async () => {
      const { vectorStore, orchestrator, searchCalls, sentinel } =
        makeMockBackends();

      // Before injection: FTS fallback, orchestrator untouched
      service.addObservation(makeObservation({ title: "JWT authentication" }));
      const before = await service.search("authentication");
      expect(before[0]?.title).toBe("JWT authentication");
      expect(searchCalls).toHaveLength(0);

      service.setSearchBackends(vectorStore, orchestrator);

      const after = await service.search("authentication");
      expect(after).toEqual(sentinel);
      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0]?.[0]).toBe("authentication");
    });

    it("auto-indexes new observations via the injected vectorStore", () => {
      const { vectorStore, orchestrator, indexCalls } = makeMockBackends();
      service.setSearchBackends(vectorStore, orchestrator);

      const obs = service.addObservation(
        makeObservation({ title: "Indexed observation" }),
      );

      expect(indexCalls).toHaveLength(1);
      expect(indexCalls[0]?.[0]).toBe(obs.id);
      expect(indexCalls[0]?.[1]).toBe("Indexed observation");
    });

    it("reports vector availability after injection", () => {
      const { vectorStore, orchestrator } = makeMockBackends();

      expect(service.isVectorAvailable()).toBe(false);
      service.setSearchBackends(vectorStore, orchestrator);
      expect(service.isVectorAvailable()).toBe(true);
    });
  });

  describe("updateObservation (vector re-index)", () => {
    function makeVectorSpy() {
      const indexCalls: unknown[][] = [];
      const removeCalls: number[] = [];
      const vectorStore = {
        isAvailable: () => true,
        indexObservation: (...args: unknown[]) => {
          indexCalls.push(args);
          return Promise.resolve(3);
        },
        removeObservation: (id: number) => {
          removeCalls.push(id);
        },
      } as unknown as VectorStore;
      const orchestrator = {
        search: () => Promise.resolve([]),
        isVectorAvailable: () => true,
      } as unknown as SearchOrchestrator;
      return { vectorStore, orchestrator, indexCalls, removeCalls };
    }

    it("updates the observation and re-indexes the vector (remove then index)", () => {
      const { vectorStore, orchestrator, indexCalls, removeCalls } =
        makeVectorSpy();
      service.setSearchBackends(vectorStore, orchestrator);

      const obs = service.addObservation(
        makeObservation({ content: "before" }),
      );
      indexCalls.length = 0; // ignore the insert-time index call

      const updated = service.updateObservation(obs.id, {
        content: "after correction",
      });

      expect(updated!.content).toBe("after correction");
      // Old embedding removed, new content re-indexed.
      expect(removeCalls).toContain(obs.id);
      expect(indexCalls).toHaveLength(1);
      expect(indexCalls[0]?.[0]).toBe(obs.id);
      expect(indexCalls[0]?.[2]).toBe("after correction"); // new content
    });

    it("returns null for a non-existent id and does not touch the vector store", () => {
      const { vectorStore, orchestrator, indexCalls, removeCalls } =
        makeVectorSpy();
      service.setSearchBackends(vectorStore, orchestrator);

      expect(service.updateObservation(999, { content: "x" })).toBeNull();
      expect(removeCalls).toHaveLength(0);
      expect(indexCalls).toHaveLength(0);
    });
  });

  describe("prune", () => {
    it("should prune old observations", () => {
      const now = Date.now();
      service.addObservation(makeObservation({ timestamp: now - 200_000 }));
      service.addObservation(makeObservation({ timestamp: now }));

      const pruned = service.prune(100_000);
      expect(pruned).toBe(1);

      const stats = service.getStats();
      expect(stats.totalObservations).toBe(1);
    });
  });

  describe("searchFtsOnly freshness re-ranking (Task 6)", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("surfaces a fresher/higher-quality match that bm25 ranks past the limit", () => {
      const now = Date.now();
      // Several stale, low-quality items with a STRONG bm25 signal (keyword
      // repeated) so they dominate raw bm25 order and fill the limit.
      for (let i = 0; i < 6; i++) {
        service.addObservation(
          makeObservation({
            title: `stale widget widget widget ${i}`,
            content: "widget widget widget widget",
            timestamp: now - 200 * DAY,
            metadata: { confidence: 0.1 },
          }),
        );
      }
      // One fresh, high-quality item with a WEAKER bm25 signal (keyword once)
      // → raw bm25 ranks it last, past a small limit.
      service.addObservation(
        makeObservation({
          title: "fresh widget",
          content: "recent and trustworthy",
          timestamp: now,
          metadata: { confidence: 1.0 },
        }),
      );

      const results = service.searchSync("widget", { limit: 1 });
      expect(results.length).toBe(1);
      // With freshness re-ranking over an over-fetched candidate set, the
      // fresh/high-quality item wins the single slot.
      expect(results[0].title).toBe("fresh widget");
    });

    it("passes through explicit date_desc ordering without freshness re-rank", () => {
      const now = Date.now();
      const older = service.addObservation(
        makeObservation({
          title: "alpha older",
          content: "alpha",
          timestamp: now - 10 * DAY,
          metadata: { confidence: 1.0 },
        }),
      );
      const newer = service.addObservation(
        makeObservation({
          title: "alpha newer",
          content: "alpha",
          timestamp: now,
          metadata: { confidence: 0.1 },
        }),
      );

      const results = service.searchSync("alpha", {
        limit: 10,
        orderBy: "date_desc",
      });
      // date_desc must be preserved: newest first regardless of quality.
      expect(results[0].id).toBe(newer.id);
      expect(results[1].id).toBe(older.id);
    });
  });
});
