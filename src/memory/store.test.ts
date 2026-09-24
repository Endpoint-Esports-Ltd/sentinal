/**
 * Memory Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import type { CreateObservation } from "./types.js";

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
      const obs2 = store.insertObservation(
        makeObservation({ title: "Second" }),
      );

      expect(obs2.id).toBe(obs1.id + 1);
    });

    it("should set quality_score from metadata confidence", () => {
      const obs = store.insertObservation(
        makeObservation({ metadata: { confidence: 0.75 } }),
      );
      expect(obs.qualityScore).toBeCloseTo(0.75);
    });

    it("should default quality_score to 1.0 when no confidence", () => {
      const obs = store.insertObservation(
        makeObservation({ metadata: { source: "test" } }),
      );
      expect(obs.qualityScore).toBe(1.0);
    });

    it("should include qualityScore in deserialized observations", () => {
      const inserted = store.insertObservation(makeObservation());
      const retrieved = store.getObservation(inserted.id);
      expect(retrieved!.qualityScore).toBeDefined();
      expect(typeof retrieved!.qualityScore).toBe("number");
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
      const obs2 = store.insertObservation(
        makeObservation({ title: "Second" }),
      );
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

  describe("updateObservation", () => {
    it("should return null for a non-existent ID", () => {
      expect(store.updateObservation(999, { content: "x" })).toBeNull();
    });

    it("should update the given fields and return the observation", () => {
      const obs = store.insertObservation(
        makeObservation({ title: "Old title", content: "old content" }),
      );
      const updated = store.updateObservation(obs.id, {
        title: "New title",
        content: "new content",
        tags: ["fresh"],
      });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("New title");
      expect(updated!.content).toBe("new content");
      expect(updated!.tags).toEqual(["fresh"]);
      // Untouched fields preserved
      expect(updated!.type).toBe(obs.type);
      expect(updated!.projectPath).toBe(obs.projectPath);
    });

    it("should reset timestamp and quality_score to fresh on update", () => {
      const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      const obs = store.insertObservation(
        makeObservation({ timestamp: oldTs }),
      );
      // Simulate a decayed quality score.
      store
        .getRawDb()
        .run("UPDATE observations SET quality_score = 0.2 WHERE id = ?", [
          obs.id,
        ]);

      const updated = store.updateObservation(obs.id, { content: "corrected" });
      expect(updated!.timestamp).toBeGreaterThan(oldTs);
      expect(updated!.qualityScore).toBeGreaterThan(0.2); // refreshed
    });

    it("should keep FTS in sync: new content found, old content not", () => {
      const obs = store.insertObservation(
        makeObservation({ content: "zebraphrase unique original" }),
      );
      store.updateObservation(obs.id, {
        content: "giraffephrase unique corrected",
      });

      const foundNew = store.searchFTS('"giraffephrase"', {
        limit: 10,
        offset: 0,
        orderBy: "relevance",
        exactMatch: false,
      });
      const foundOld = store.searchFTS('"zebraphrase"', {
        limit: 10,
        offset: 0,
        orderBy: "relevance",
        exactMatch: false,
      });
      expect(foundNew.some((o) => o.id === obs.id)).toBe(true);
      expect(foundOld.some((o) => o.id === obs.id)).toBe(false);
    });
  });

  describe("getRecentForProject", () => {
    it("should return observations for a specific project", () => {
      store.insertObservation(
        makeObservation({ projectPath: "/project-a", timestamp: 100 }),
      );
      store.insertObservation(
        makeObservation({ projectPath: "/project-b", timestamp: 200 }),
      );
      store.insertObservation(
        makeObservation({ projectPath: "/project-a", timestamp: 300 }),
      );

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
      store.insertObservation(
        makeObservation({
          title: "JWT authentication bug",
          content: "Token expired",
        }),
      );
      store.insertObservation(
        makeObservation({
          title: "Database migration",
          content: "Added users table",
        }),
      );

      const results = store.searchFTS('"authentication"', {
        limit: 20,
        offset: 0,
        orderBy: "relevance",
        exactMatch: false,
      });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("JWT authentication bug");
    });

    it("should search across title and content", () => {
      store.insertObservation(
        makeObservation({
          title: "Bug fix",
          content: "Fixed the authentication token refresh",
        }),
      );

      const results = store.searchFTS('"authentication"', {
        limit: 20,
        offset: 0,
        orderBy: "relevance",
        exactMatch: false,
      });
      expect(results).toHaveLength(1);
    });
  });

  describe("searchFilters", () => {
    it("should filter by type", () => {
      store.insertObservation(makeObservation({ type: "decision" }));
      store.insertObservation(makeObservation({ type: "error" }));
      store.insertObservation(makeObservation({ type: "decision" }));

      const results = store.searchFilters({
        type: "decision",
        limit: 20,
        offset: 0,
        orderBy: "date_desc",
        exactMatch: false,
      });
      expect(results).toHaveLength(2);
    });

    it("should filter by date range", () => {
      store.insertObservation(makeObservation({ timestamp: 100 }));
      store.insertObservation(makeObservation({ timestamp: 200 }));
      store.insertObservation(makeObservation({ timestamp: 300 }));

      const results = store.searchFilters({
        dateStart: 150,
        dateEnd: 250,
        limit: 20,
        offset: 0,
        orderBy: "date_desc",
        exactMatch: false,
      });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp).toBe(200);
    });

    it("should filter by tags", () => {
      store.insertObservation(
        makeObservation({ tags: ["angular", "signals"] }),
      );
      store.insertObservation(makeObservation({ tags: ["nestjs", "dto"] }));

      const results = store.searchFilters({
        tags: ["angular"],
        limit: 20,
        offset: 0,
        orderBy: "date_desc",
        exactMatch: false,
      });
      expect(results).toHaveLength(1);
    });
  });

  describe("getTimelineAround", () => {
    it("should return before and after context", () => {
      const obs1 = store.insertObservation(
        makeObservation({ timestamp: 100, title: "Before" }),
      );
      const obs2 = store.insertObservation(
        makeObservation({ timestamp: 200, title: "Anchor" }),
      );
      const obs3 = store.insertObservation(
        makeObservation({ timestamp: 300, title: "After" }),
      );

      const { anchor, before, after } = store.getTimelineAround(
        obs2.id,
        10,
        10,
      );

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
        transcriptPath: null,
      });

      expect(session.id).toBe("sess-1");
      expect(session.assistant).toBe("claude-code");
      expect(session.transcriptPath).toBeNull();

      const retrieved = store.getSession("sess-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("sess-1");
    });

    it("should store and retrieve transcript_path", () => {
      const session = store.insertSession({
        id: "sess-tp",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/test",
        assistant: "claude-code",
        summary: null,
        transcriptPath: "/tmp/transcript.jsonl",
      });

      expect(session.transcriptPath).toBe("/tmp/transcript.jsonl");

      const retrieved = store.getSession("sess-tp");
      expect(retrieved!.transcriptPath).toBe("/tmp/transcript.jsonl");
    });

    it("should end a session with summary and observation count", () => {
      store.insertSession({
        id: "sess-2",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/test",
        assistant: "opencode",
        summary: null,
        transcriptPath: null,
      });

      store.insertObservation(makeObservation({ sessionId: "sess-2" }));
      store.insertObservation(makeObservation({ sessionId: "sess-2" }));

      store.endSession("sess-2", "Did some work");

      const session = store.getSession("sess-2");
      expect(session!.endTime).not.toBeNull();
      expect(session!.summary).toBe("Did some work");
      expect(session!.observationCount).toBe(2);
    });

    it("should list active sessions only", () => {
      store.insertSession({
        id: "active-1",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/proj-a",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });
      store.insertSession({
        id: "ended-1",
        startTime: Date.now() - 10000,
        endTime: Date.now(),
        projectPath: "/proj-a",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });
      store.insertSession({
        id: "active-2",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/proj-b",
        assistant: "opencode",
        summary: null,
        transcriptPath: null,
      });

      const active = store.getActiveSessions();
      expect(active.length).toBe(2);
      expect(active.every((s) => s.endTime === null)).toBe(true);
    });

    it("should list sessions with filters", () => {
      store.insertSession({
        id: "f-1",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/proj-x",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });
      store.insertSession({
        id: "f-2",
        startTime: Date.now(),
        endTime: null,
        projectPath: "/proj-x",
        assistant: "opencode",
        summary: null,
        transcriptPath: null,
      });
      store.insertSession({
        id: "f-3",
        startTime: Date.now(),
        endTime: Date.now(),
        projectPath: "/proj-y",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });

      const byProject = store.listSessions({ project: "/proj-x" });
      expect(byProject.length).toBe(2);

      const byAssistant = store.listSessions({ assistant: "opencode" });
      expect(byAssistant.length).toBe(1);
      expect(byAssistant[0].id).toBe("f-2");

      const ended = store.listSessions({ active: false });
      expect(ended.length).toBe(1);
      expect(ended[0].id).toBe("f-3");
    });

    it("should clean up stale sessions", () => {
      const now = Date.now();
      // Active session started 25 hours ago (stale)
      store.insertSession({
        id: "stale-1",
        startTime: now - 25 * 60 * 60 * 1000,
        endTime: null,
        projectPath: "/test",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });
      // Active session started 1 hour ago (not stale)
      store.insertSession({
        id: "fresh-1",
        startTime: now - 1 * 60 * 60 * 1000,
        endTime: null,
        projectPath: "/test",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });

      const cleaned = store.cleanupStaleSessions();
      expect(cleaned).toBe(1);

      const stale = store.getSession("stale-1");
      expect(stale!.endTime).not.toBeNull();

      const fresh = store.getSession("fresh-1");
      expect(fresh!.endTime).toBeNull();
    });

    it("should use custom stale threshold", () => {
      const now = Date.now();
      store.insertSession({
        id: "custom-1",
        startTime: now - 2 * 60 * 60 * 1000,
        endTime: null,
        projectPath: "/test",
        assistant: "claude-code",
        summary: null,
        transcriptPath: null,
      });

      // 1-hour threshold should catch the 2-hour-old session
      const cleaned = store.cleanupStaleSessions(1 * 60 * 60 * 1000);
      expect(cleaned).toBe(1);
    });
  });

  describe("stats", () => {
    it("should return aggregate statistics", () => {
      store.insertObservation(
        makeObservation({ type: "decision", timestamp: 100 }),
      );
      store.insertObservation(
        makeObservation({ type: "error", timestamp: 200 }),
      );
      store.insertObservation(
        makeObservation({ type: "decision", timestamp: 300 }),
      );

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

  describe("settings", () => {
    it("should return null for nonexistent key", () => {
      expect(store.getSetting("nonexistent")).toBeNull();
    });

    it("should set and get a string value", () => {
      store.setSetting("theme", '"dark"');
      expect(store.getSetting("theme")).toBe('"dark"');
    });

    it("should set and get a JSON object", () => {
      const routing = JSON.stringify({
        planning: "opus",
        implementation: "sonnet",
      });
      store.setSetting("model_routing", routing);
      const result = JSON.parse(store.getSetting("model_routing")!);
      expect(result.planning).toBe("opus");
      expect(result.implementation).toBe("sonnet");
    });

    it("should overwrite existing value", () => {
      store.setSetting("key", '"value1"');
      store.setSetting("key", '"value2"');
      expect(store.getSetting("key")).toBe('"value2"');
    });

    it("should delete a setting", () => {
      store.setSetting("to_delete", '"temp"');
      expect(store.getSetting("to_delete")).not.toBeNull();
      store.deleteSetting("to_delete");
      expect(store.getSetting("to_delete")).toBeNull();
    });

    it("should delete nonexistent key without error", () => {
      expect(() => store.deleteSetting("nonexistent")).not.toThrow();
    });

    it("should list all settings", () => {
      store.setSetting("alpha", '"a"');
      store.setSetting("beta", '"b"');
      const list = store.listSettings();
      expect(list.length).toBeGreaterThanOrEqual(2);
      const keys = list.map((s) => s.key);
      expect(keys).toContain("alpha");
      expect(keys).toContain("beta");
    });

    it("should return empty list when no settings exist", () => {
      // Fresh store — any settings from previous tests were in the same store instance
      // Create a fresh store to test empty state
      const freshStore = new MemoryStore(":memory:");
      const list = freshStore.listSettings();
      expect(list).toEqual([]);
      freshStore.close();
    });

    it("should include updatedAt timestamp", () => {
      const before = Date.now();
      store.setSetting("timed", '"value"');
      const list = store.listSettings();
      const setting = list.find((s) => s.key === "timed");
      expect(setting).toBeDefined();
      expect(setting!.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // Task 6 (signals-that-reach-nobody): tdd_cycles.project_path (V13).
  describe("TDD cycle project scoping", () => {
    it("records the project on write and returns it on read", () => {
      store.setTddState({
        filePath: "/proj-a/src/a.ts",
        state: "RED_CONFIRMED",
        projectPath: "/proj-a",
      });
      expect(store.getTddState("/proj-a/src/a.ts")!.projectPath).toBe(
        "/proj-a",
      );
    });

    it("maps a write without a project to null", () => {
      store.setTddState({ filePath: "/x/y.ts", state: "TEST_WRITTEN" });
      expect(store.getTddState("/x/y.ts")!.projectPath).toBeNull();
    });

    it("accepts synthetic (non-existent) project paths verbatim — no normalization in the store", () => {
      store.setTddState({
        filePath: "/test/project/f.ts",
        state: "TEST_WRITTEN",
        projectPath: "/test/project/",
      });
      expect(store.getTddState("/test/project/f.ts")!.projectPath).toBe(
        "/test/project/",
      );
    });

    it("ON CONFLICT: a later write that omits the project keeps the recorded one", () => {
      store.setTddState({
        filePath: "/proj-a/src/a.ts",
        state: "TEST_WRITTEN",
        projectPath: "/proj-a",
      });
      store.setTddState({
        filePath: "/proj-a/src/a.ts",
        state: "RED_CONFIRMED",
      });
      const row = store.getTddState("/proj-a/src/a.ts")!;
      expect(row.state).toBe("RED_CONFIRMED");
      expect(row.projectPath).toBe("/proj-a");
    });

    it("ON CONFLICT: a later write that supplies a project overwrites it (heals NULL rows)", () => {
      store.setTddState({ filePath: "/p/f.ts", state: "TEST_WRITTEN" });
      store.setTddState({
        filePath: "/p/f.ts",
        state: "TEST_WRITTEN",
        projectPath: "/p",
      });
      expect(store.getTddState("/p/f.ts")!.projectPath).toBe("/p");
      store.setTddState({
        filePath: "/p/f.ts",
        state: "TEST_WRITTEN",
        projectPath: "/q",
      });
      expect(store.getTddState("/p/f.ts")!.projectPath).toBe("/q");
    });

    describe("listActiveTddStates project filter", () => {
      beforeEach(() => {
        store.setTddState({
          filePath: "/proj-a/a.ts",
          state: "RED_CONFIRMED",
          projectPath: "/proj-a",
        });
        store.setTddState({
          filePath: "/proj-b/b.ts",
          state: "RED_CONFIRMED",
          projectPath: "/proj-b",
        });
        store.setTddState({ filePath: "/legacy/c.ts", state: "RED_CONFIRMED" });
        store.setTddState({
          filePath: "/proj-a/idle.ts",
          state: "IDLE",
          projectPath: "/proj-a",
        });
      });

      it("with no project returns every active row, including NULL-project (fails OPEN, D6)", () => {
        const paths = store.listActiveTddStates().map((c) => c.filePath);
        expect(paths.sort()).toEqual(
          ["/legacy/c.ts", "/proj-a/a.ts", "/proj-b/b.ts"].sort(),
        );
        expect(store.listActiveTddStates(null, null)).toHaveLength(3);
      });

      it("with a project returns only that project's rows (NULL-project excluded)", () => {
        const rows = store.listActiveTddStates(null, "/proj-a");
        expect(rows.map((c) => c.filePath)).toEqual(["/proj-a/a.ts"]);
        expect(rows[0].projectPath).toBe("/proj-a");
      });

      it("combines spec and project filters with AND", () => {
        // tdd_cycles.spec_id is an FK to specs(id).
        store.getRawDb().run(
          `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
             VALUES ('s1', '/proj-a', 'T', 't', 'feature', 'PENDING', '/plan.md', 1, 1)`,
        );
        store.setTddState({
          filePath: "/proj-a/spec.ts",
          state: "TEST_WRITTEN",
          specId: "s1",
          projectPath: "/proj-a",
        });
        store.setTddState({
          filePath: "/proj-b/spec.ts",
          state: "TEST_WRITTEN",
          specId: "s1",
          projectPath: "/proj-b",
        });
        expect(
          store.listActiveTddStates("s1", "/proj-a").map((c) => c.filePath),
        ).toEqual(["/proj-a/spec.ts"]);
        expect(store.listActiveTddStates("s1")).toHaveLength(2);
      });
    });
  });
});

// ─── Error signature de-duplication primitives (Task 7, D3) ───────────────

describe("MemoryStore — error signature dedupe", () => {
  let store: MemoryStore;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });
  afterEach(() => {
    store.close();
  });

  function signedError(
    overrides: Partial<CreateObservation> = {},
  ): CreateObservation {
    return makeObservation({
      type: "error",
      timestamp: T0,
      metadata: { signature: "sig-a", occurrences: 1 },
      ...overrides,
    });
  }

  describe("findRecentErrorBySignature", () => {
    it("finds an error with the signature in the project after the cutoff", () => {
      const obs = store.insertObservation(signedError());
      const found = store.findRecentErrorBySignature(
        "/test/project",
        "sig-a",
        T0 - 1,
      );
      expect(found?.id).toBe(obs.id);
    });

    it("excludes rows at or before the cutoff (strict >)", () => {
      store.insertObservation(signedError());
      expect(
        store.findRecentErrorBySignature("/test/project", "sig-a", T0),
      ).toBeNull();
    });

    it("excludes a different signature, a different project and a non-error type", () => {
      store.insertObservation(
        signedError({ metadata: { signature: "sig-b" } }),
      );
      store.insertObservation(signedError({ projectPath: "/other/project" }));
      store.insertObservation(signedError({ type: "discovery" }));
      expect(
        store.findRecentErrorBySignature("/test/project", "sig-a", T0 - 1),
      ).toBeNull();
    });

    it("returns the newest match first", () => {
      store.insertObservation(signedError({ timestamp: T0 }));
      const newer = store.insertObservation(
        signedError({ timestamp: T0 + 1000 }),
      );
      store.insertObservation(signedError({ timestamp: T0 + 500 }));
      expect(
        store.findRecentErrorBySignature("/test/project", "sig-a", T0 - 1)?.id,
      ).toBe(newer.id);
    });
  });

  describe("recordErrorRepeat", () => {
    it("increments occurrences and sets lastSeen without touching timestamp, quality or other metadata", () => {
      const obs = store.insertObservation(
        signedError({
          metadata: { signature: "sig-a", occurrences: 1, confidence: 0.5 },
        }),
      );
      (store as any).db.run(
        "UPDATE observations SET quality_score = 0.3 WHERE id = ?",
        [obs.id],
      );

      const after = store.recordErrorRepeat(obs.id, T0 + 60_000);
      expect(after!.metadata.occurrences).toBe(2);
      expect(after!.metadata.lastSeen).toBe(T0 + 60_000);
      expect(after!.metadata.signature).toBe("sig-a");
      expect(after!.metadata.confidence).toBe(0.5);
      expect(after!.timestamp).toBe(T0);
      expect(after!.qualityScore).toBe(0.3);
      expect(after!.title).toBe(obs.title);
    });

    it("treats a missing occurrences as 1", () => {
      const obs = store.insertObservation(
        signedError({ metadata: { signature: "sig-a" } }),
      );
      expect(
        store.recordErrorRepeat(obs.id, T0 + 1)!.metadata.occurrences,
      ).toBe(2);
    });

    it("returns null for a missing id", () => {
      expect(store.recordErrorRepeat(999, T0)).toBeNull();
    });

    it("keeps the row findable through FTS after the metadata-only update", () => {
      const obs = store.insertObservation(
        signedError({ title: "zebracorn failure", content: "zebracorn" }),
      );
      store.recordErrorRepeat(obs.id, T0 + 1);
      store.recordErrorRepeat(obs.id, T0 + 2);
      const hits = store.searchFTS('"zebracorn"', {
        limit: 10,
        offset: 0,
        orderBy: "relevance",
      } as any);
      expect(hits.map((h) => h.id)).toEqual([obs.id]);
      const ftsRows = (store as any).db
        .prepare(
          "SELECT COUNT(*) AS n FROM observations_fts WHERE observations_fts MATCH 'zebracorn'",
        )
        .get() as { n: number };
      expect(ftsRows.n).toBe(1);
    });
  });
});
