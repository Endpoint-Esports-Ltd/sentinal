/**
 * Memory MCP Tools Tests
 *
 * Tests for memory_maintain tool registration and behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { decayQualityScores } from "./maintenance.js";
import { formatMemoryStats, registerMemoryTools } from "./mcp-tools.js";
import { captureTools, makeTmpDir } from "../test-helpers.js";
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

describe("memory_update / memory_delete MCP tools", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mem-ud-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new MemoryStore(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(content: string): number {
    return new MemoryService(store).addObservation({
      sessionId: "s",
      projectPath: "/p",
      timestamp: Date.now(),
      type: "discovery",
      title: "seed",
      content,
      filePaths: [],
      tags: [],
      metadata: {},
    }).id;
  }

  it("registers both tools", () => {
    const tools = captureTools(registerMemoryTools, { store });
    expect(tools.has("memory_update")).toBe(true);
    expect(tools.has("memory_delete")).toBe(true);
  });

  it("memory_update updates the observation via the service (direct path)", async () => {
    const id = seed("original");
    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_update")!({
      id,
      content: "corrected",
    });
    expect(result.content[0].text).toContain(String(id));
    expect(store.getObservation(id)!.content).toBe("corrected");
  });

  it("memory_delete removes the observation via the service (direct path)", async () => {
    const id = seed("to delete");
    const tools = captureTools(registerMemoryTools, { store });
    await tools.get("memory_delete")!({ id });
    expect(store.getObservation(id)).toBeNull();
  });

  it("memory_update reports a graceful message for a missing id", async () => {
    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_update")!({ id: 999, content: "x" });
    expect(result.content[0].text.toLowerCase()).toContain("not found");
  });
});

// --- Worktree-aware project filters (read side) ---

/**
 * `memory_search`'s `project` filter is exact equality in THREE places —
 * `store-observations.ts` (FTS), `vector-store.ts` (JS post-filter) and the
 * hybrid fan-out in `search/strategies/hybrid.ts`. Wave 3 made every WRITE
 * canonical, so calling from a linked worktree matched nothing at all: the
 * originally-reported bug (0 results from this checkout, 235 rows under the
 * main checkout's key).
 *
 * Normalizing ONCE at the MCP tool boundary covers all three, and also covers
 * the sidecar path — `/memory/search` (`src/sidecar/routes.ts:375`) passes
 * `body.project` straight through without normalizing.
 *
 * Fixtures are REAL git repos with REAL linked worktrees; a fake path proves
 * nothing because `resolveProjectIdentity("/test")` returns `/test` unchanged.
 */
function initRepoForIdentity(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir });
}

describe("memory read-tool project identity", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtPath: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    // realpathSync pre-applied: /var symlinks to /private/var on macOS and
    // resolveProjectIdentity canonicalizes, so raw tmp paths never compare equal.
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepoForIdentity(repoDir);
    wtPath = join(tmpDir, "wt-feature");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature"], {
      cwd: repoDir,
    });

    store = new MemoryStore(join(tmpDir, "identity.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_search with a worktree path finds observations stored under the canonical path", async () => {
    service.addObservation(
      makeObservation({
        projectPath: repoDir, // canonical key, as Wave 3 writes it
        title: "Sidecar socket retry",
        content: "The sidecar retries the unix socket before HTTP.",
      }),
    );

    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_search")!({
      query: "sidecar socket retry",
      project: wtPath, // caller stands in the linked worktree
    });

    expect(result.content[0].text).toContain("Sidecar socket retry");
  }, 30_000);

  it("memory_search still excludes observations from an UNRELATED project", async () => {
    service.addObservation(
      makeObservation({
        projectPath: "/some/other/project",
        title: "Unrelated socket retry",
        content: "The sidecar retries the unix socket before HTTP.",
      }),
    );

    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_search")!({
      query: "sidecar socket retry",
      project: wtPath,
    });

    expect(result.content[0].text).not.toContain("Unrelated socket retry");
  }, 30_000);

  it("memory_timeline with a worktree path finds canonically-keyed neighbours", async () => {
    const anchor = service.addObservation(
      makeObservation({ projectPath: repoDir, title: "Anchor obs" }),
    );
    service.addObservation(
      makeObservation({
        projectPath: repoDir,
        title: "Neighbour obs",
        timestamp: Date.now() + 1000,
      }),
    );

    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_timeline")!({
      anchor: anchor.id,
      project: wtPath,
    });

    expect(result.content[0].text).toContain("Neighbour obs");
  }, 30_000);
});
