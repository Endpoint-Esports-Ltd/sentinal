/**
 * Memory Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import type { CreateObservation } from "./types.js";

function makeObservation(overrides: Partial<CreateObservation> = {}): CreateObservation {
  return {
    sessionId: "session-1",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "This is a test observation content",
    filePaths: ["src/test.ts"],
    tags: ["test", "unit"],
    metadata: { source: "test" },
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Use in-memory database for tests
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("insertObservation", () => {
    it("should insert and return an observation with an ID", () => {
      const obs = store.insertObservation(makeObservation());

      expect(obs.id).toBeGreaterThan(0);
      expect(obs.title).toBe("Test observation");
      expect(obs.type).toBe("discovery");
      expect(obs.filePaths).toEqual(["src/test.ts"]);
      expect(obs.tags).toEqual(["test", "unit"]);
    });

    it("should auto-increment IDs", () => {
      const obs1 = store.insertObservation(makeObservation());
      const obs2 = store.insertObservation(makeObservation({ title: "Second" }));

      expect(obs2.id).toBe(obs1.id + 1);
    });
  });

  describe("getObservation", () => {
    it("should return null for non-existent ID", () => {
      expect(store.getObservation(999)).toBeNull();
    });

    it("should return the observation by ID", () => {
      const inserted = store.insertObservation(makeObservation());
      const retrieved = store.getObservation(inserted.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(inserted.id);
      expect(retrieved!.title).toBe(inserted.title);
    });
  });

  describe("getObservations", () => {
    it("should return empty array for empty IDs", () => {
      expect(store.getObservations([])).toEqual([]);
    });

    it("should return multiple observations by IDs", () => {
      const obs1 = store.insertObservation(makeObservation({ title: "First" }));
      const obs2 = store.insertObservation(makeObservation({ title: "Second" }));
      store.insertObservation(makeObservation({ title: "Third" }));

      const results = store.getObservations([obs1.id, obs2.id]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.title)).toContain("First");
      expect(results.map((r) => r.title)).toContain("Second");
    });
  });

  describe("deleteObservation", () => {
    it("should return false for non-existent ID", () => {
      expect(store.deleteObservation(999)).toBe(false);
    });

    it("should delete and return true", () => {
      const obs = store.insertObservation(makeObservation());
      expect(store.deleteObservation(obs.id)).toBe(true);
      expect(store.getObservation(obs.id)).toBeNull();
    });
  });

  describe("getRecentForProject", () => {
    it("should return observations for a specific project", () => {
      store.insertObservation(makeObservation({ projectPath: "/project-a", timestamp: 100 }));
      store.insertObservation(makeObservation({ projectPath: "/project-b", timestamp: 200 }));
      store.insertObservation(makeObservation({ projectPath: "/project-a", timestamp: 300 }));

      const results = store.getRecentForProject("/project-a");
      expect(results).toHaveLength(2);
      // Should be ordered by timestamp DESC
      expect(results[0].timestamp).toBe(300);
      expect(results[1].timestamp).toBe(100);
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.insertObservation(makeObservation({ timestamp: i }));
      }

      const results = store.getRecentForProject("/test/project", 3);
      expect(results).toHaveLength(3);
    });
  });

  describe("searchFTS", () => {
    it("should find observations by keyword", () => {
      store.insertObservation(makeObservation({ title: "JWT authentication bug", content: "Token expired" }));
      store.insertObservation(makeObservation({ title: "Database migration", content: "Added users table" }));

      const results = store.searchFTS('"authentication"', { limit: 20, offset: 0, orderBy: "relevance", exactMatch: false });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("JWT authentication bug");
    });

    it("should search across title and content", () => {
      store.insertObservation(makeObservation({ title: "Bug fix", content: "Fixed the authentication token refresh" }));

      const results = store.searchFTS('"authentication"', { limit: 20, offset: 0, orderBy: "relevance", exactMatch: false });
      expect(results).toHaveLength(1);
    });
  });

  describe("searchFilters", () => {
    it("should filter by type", () => {
      store.insertObservation(makeObservation({ type: "decision" }));
      store.insertObservation(makeObservation({ type: "error" }));
      store.insertObservation(makeObservation({ type: "decision" }));

      const results = store.searchFilters({ type: "decision", limit: 20, offset: 0, orderBy: "date_desc", exactMatch: false });
      expect(results).toHaveLength(2);
    });

    it("should filter by date range", () => {
      store.insertObservation(makeObservation({ timestamp: 100 }));
      store.insertObservation(makeObservation({ timestamp: 200 }));
      store.insertObservation(makeObservation({ timestamp: 300 }));

      const results = store.searchFilters({ dateStart: 150, dateEnd: 250, limit: 20, offset: 0, orderBy: "date_desc", exactMatch: false });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp).toBe(200);
    });

    it("should filter by tags", () => {
      store.insertObservation(makeObservation({ tags: ["angular", "signals"] }));
      store.insertObservation(makeObservation({ tags: ["nestjs", "dto"] }));

      const results = store.searchFilters({ tags: ["angular"], limit: 20, offset: 0, orderBy: "date_desc", exactMatch: false });
      expect(results).toHaveLength(1);
    });
  });

  describe("getTimelineAround", () => {
    it("should return before and after context", () => {
      const obs1 = store.insertObservation(makeObservation({ timestamp: 100, title: "Before" }));
      const obs2 = store.insertObservation(makeObservation({ timestamp: 200, title: "Anchor" }));
      const obs3 = store.insertObservation(makeObservation({ timestamp: 300, title: "After" }));

      const { anchor, before, after } = store.getTimelineAround(obs2.id, 10, 10);

      expect(anchor).not.toBeNull();
      expect(anchor!.title).toBe("Anchor");
      expect(before).toHaveLength(1);
      expect(before[0].title).toBe("Before");
      expect(after).toHaveLength(1);
      expect(after[0].title).toBe("After");
    });

    it("should return null anchor for non-existent ID", () => {
      const { anchor } = store.getTimelineAround(999);
      expect(anchor).toBeNull();
    });
  });

  describe("sessions", () => {
    it("should create and retrieve a session", () => {
      const session = store.insertSession({
        id: "sess-1",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/test",
        assistant: "claude-code",
        summary: null,
      });

      expect(session.id).toBe("sess-1");
      expect(session.assistant).toBe("claude-code");

      const retrieved = store.getSession("sess-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("sess-1");
    });

    it("should end a session with summary and observation count", () => {
      store.insertSession({
        id: "sess-2",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/test",
        assistant: "opencode",
        summary: null,
      });

      store.insertObservation(makeObservation({ sessionId: "sess-2" }));
      store.insertObservation(makeObservation({ sessionId: "sess-2" }));

      store.endSession("sess-2", "Did some work");

      const session = store.getSession("sess-2");
      expect(session!.endTime).not.toBeNull();
      expect(session!.summary).toBe("Did some work");
      expect(session!.observationCount).toBe(2);
    });
  });

  describe("stats", () => {
    it("should return aggregate statistics", () => {
      store.insertObservation(makeObservation({ type: "decision", timestamp: 100 }));
      store.insertObservation(makeObservation({ type: "error", timestamp: 200 }));
      store.insertObservation(makeObservation({ type: "decision", timestamp: 300 }));

      const stats = store.getStats();
      expect(stats.totalObservations).toBe(3);
      expect(stats.byType.decision).toBe(2);
      expect(stats.byType.error).toBe(1);
      expect(stats.oldestTimestamp).toBe(100);
      expect(stats.newestTimestamp).toBe(300);
    });
  });

  describe("prune", () => {
    it("should delete observations older than cutoff", () => {
      const now = Date.now();
      store.insertObservation(makeObservation({ timestamp: now - 100_000 }));
      store.insertObservation(makeObservation({ timestamp: now - 50_000 }));
      store.insertObservation(makeObservation({ timestamp: now }));

      const pruned = store.prune(60_000); // prune older than 60s
      expect(pruned).toBe(1);

      const stats = store.getStats();
      expect(stats.totalObservations).toBe(2);
    });
  });
});
