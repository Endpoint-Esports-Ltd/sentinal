/**
 * Memory MCP Tools Tests
 *
 * Tests for memory_maintain tool registration and behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { decayQualityScores } from "./maintenance.js";
import { formatMemoryStats } from "./mcp-tools.js";
import type { CreateObservation, MemoryStats } from "./types.js";

function makeTmpDb(): string {
  const dir = join(
    tmpdir(),
    `sentinal-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "test-session",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "Some test content",
    filePaths: [],
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

describe("memory_maintain tool logic", () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  let dbPath: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    store = new MemoryStore(dbPath);
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  describe("decay action", () => {
    it("should decay old observations and return counts", () => {
      const now = Date.now();
      service.addObservation(
        makeObservation({
          type: "error",
          timestamp: now - 2 * THIRTY_DAYS_MS,
          title: "Old error",
        }),
      );

      const result = decayQualityScores(store);
      expect(result.updated).toBeGreaterThan(0);
      expect(result.decayed).toBeGreaterThan(0);
    });
  });

  describe("prune action", () => {
    it("should delete observations below quality threshold", () => {
      const now = Date.now();
      // Create an old error that will decay below threshold
      service.addObservation(
        makeObservation({
          type: "error",
          timestamp: now - 365 * 24 * 60 * 60 * 1000,
          title: "Ancient error",
        }),
      );

      // Decay first to lower the score
      decayQualityScores(store);

      const db = store.getRawDb();
      const before = db
        .prepare("SELECT COUNT(*) as count FROM observations")
        .get() as { count: number };
      expect(before.count).toBe(1);

      // Verify the score is actually below threshold
      const row = db
        .prepare("SELECT quality_score FROM observations WHERE id = 1")
        .get() as { quality_score: number };
      expect(row.quality_score).toBeLessThan(0.15);

      // Prune observations with quality_score < 0.15
      db.run("DELETE FROM observations WHERE quality_score < ?", [0.15]);

      const after = db
        .prepare("SELECT COUNT(*) as count FROM observations")
        .get() as { count: number };
      expect(after.count).toBe(0);
    });

    it("should not delete observations above threshold", () => {
      service.addObservation(
        makeObservation({
          type: "decision",
          timestamp: Date.now(),
          title: "Recent decision",
        }),
      );

      const db = store.getRawDb();
      const before = db
        .prepare("SELECT COUNT(*) as count FROM observations")
        .get() as { count: number };

      db.run("DELETE FROM observations WHERE quality_score < ?", [0.15]);

      const after = db
        .prepare("SELECT COUNT(*) as count FROM observations")
        .get() as { count: number };
      expect(after.count).toBe(before.count);
    });
  });

  describe("stats action", () => {
    it("should return quality score distribution", () => {
      // Add observations with varying scores
      service.addObservation(
        makeObservation({
          title: "High quality",
          metadata: { confidence: 0.9 },
        }),
      );
      service.addObservation(
        makeObservation({
          title: "Low quality",
          metadata: { confidence: 0.3 },
        }),
      );
      service.addObservation(makeObservation({ title: "Default quality" }));

      const db = store.getRawDb();
      const buckets = [
        { label: "0-0.2", min: 0, max: 0.2 },
        { label: "0.2-0.4", min: 0.2, max: 0.4 },
        { label: "0.4-0.6", min: 0.4, max: 0.6 },
        { label: "0.6-0.8", min: 0.6, max: 0.8 },
        { label: "0.8-1.0", min: 0.8, max: 1.0 },
      ];

      const distribution: Record<string, number> = {};
      for (const bucket of buckets) {
        const row = db
          .prepare(
            "SELECT COUNT(*) as count FROM observations WHERE quality_score >= ? AND quality_score < ?",
          )
          .get(bucket.min, bucket.max === 1.0 ? 1.01 : bucket.max) as {
          count: number;
        };
        distribution[bucket.label] = row.count;
      }

      // 0.3 in 0.2-0.4, 0.9 in 0.8-1.0, 1.0 in 0.8-1.0
      expect(distribution["0.2-0.4"]).toBe(1);
      expect(distribution["0.8-1.0"]).toBe(2);
    });
  });
});

describe("formatMemoryStats", () => {
  function makeStats(overrides: Partial<MemoryStats> = {}): MemoryStats {
    return {
      totalObservations: 5,
      totalSessions: 2,
      byType: { decision: 2, discovery: 3, error: 0, fix: 0, pattern: 0 },
      byProject: { "/test/project": 5 },
      oldestTimestamp: Date.now() - 1000,
      newestTimestamp: Date.now(),
      databaseSizeBytes: 2048,
      ...overrides,
    };
  }

  it("omits the Vector Search section when stats has no vector field", () => {
    const out = formatMemoryStats(makeStats());
    expect(out).toContain("## Memory Statistics");
    expect(out).not.toContain("Vector Search");
  });

  it("renders ready state with vector count", () => {
    const out = formatMemoryStats(
      makeStats({
        vector: { status: "ready", count: 12, initError: null, hint: null },
      }),
    );
    expect(out).toContain("### Vector Search");
    expect(out).toContain("available");
    expect(out).toContain("12 vectors");
  });

  it("renders initializing state", () => {
    const out = formatMemoryStats(
      makeStats({
        vector: {
          status: "initializing",
          count: 0,
          initError: null,
          hint: null,
        },
      }),
    );
    expect(out).toContain("### Vector Search");
    expect(out).toContain("initializing");
  });

  it("renders unavailable state with init error and setup hint", () => {
    const out = formatMemoryStats(
      makeStats({
        vector: {
          status: "unavailable",
          count: 0,
          initError: "sqlite-vec not available",
          hint: "Run: sentinal memory setup",
        },
      }),
    );
    expect(out).toContain("### Vector Search");
    expect(out).toContain("unavailable");
    expect(out).toContain("sqlite-vec not available");
    expect(out).toContain("Run: sentinal memory setup");
  });

  it("renders disabled state", () => {
    const out = formatMemoryStats(
      makeStats({
        vector: { status: "disabled", count: 0, initError: null, hint: null },
      }),
    );
    expect(out).toContain("### Vector Search");
    expect(out).toContain("disabled");
  });
});
