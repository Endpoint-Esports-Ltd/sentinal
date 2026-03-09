/**
 * MCP Server Tests
 *
 * Tests the memory MCP server tool registration and tool logic
 * by calling the underlying service methods that tools delegate to.
 * Also validates that createMemoryServer() produces a working server.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createMemoryServer } from "./mcp-server.js";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import type { CreateObservation } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDb(): string {
  const dir = join(tmpdir(), `sentinal-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function makeObservation(overrides: Partial<CreateObservation> = {}): CreateObservation {
  return {
    sessionId: "test-session",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "Some test content for the observation",
    filePaths: [],
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createMemoryServer", () => {
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
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    } catch {
      // ignore
    }
  });

  it("should create a server and service", () => {
    const result = createMemoryServer(service);
    expect(result.server).toBeDefined();
    expect(result.service).toBe(service);
  });

  it("should create a server with default service when none provided", () => {
    const result = createMemoryServer();
    expect(result.server).toBeDefined();
    expect(result.service).toBeInstanceOf(MemoryService);
    result.service.close();
  });
});

describe("memory_search tool logic", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should return empty results for no matches", async () => {
    const results = await service.search("nonexistent query");
    expect(results).toEqual([]);
  });

  it("should find observations by keyword", async () => {
    service.addObservation(makeObservation({
      title: "Database migration strategy",
      content: "Chose sequential migrations over auto-sync",
      tags: ["database", "migration"],
    }));

    const results = await service.search("migration");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Database migration strategy");
  });

  it("should filter by project", async () => {
    service.addObservation(makeObservation({
      projectPath: "/project/alpha",
      title: "Alpha discovery",
    }));
    service.addObservation(makeObservation({
      projectPath: "/project/beta",
      title: "Beta discovery",
    }));

    const results = await service.search("discovery", { project: "/project/alpha" });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Alpha discovery");
  });

  it("should filter by type", async () => {
    service.addObservation(makeObservation({ type: "decision", title: "A decision" }));
    service.addObservation(makeObservation({ type: "error", title: "An error" }));

    const results = await service.search("", { type: "decision" });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("decision");
  });

  it("should respect limit", async () => {
    for (let i = 0; i < 10; i++) {
      service.addObservation(makeObservation({ title: `Observation ${i}` }));
    }

    const results = await service.search("Observation", { limit: 3 });
    expect(results.length).toBe(3);
  });
});

describe("memory_timeline tool logic", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should return empty entries for nonexistent anchor", () => {
    const result = service.timeline(999);
    expect(result.entries.length).toBe(0);
  });

  it("should return timeline around an anchor", () => {
    const baseTime = Date.now() - 100000;
    const obs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const o = service.addObservation(makeObservation({
        title: `Event ${i}`,
        timestamp: baseTime + i * 10000,
      }));
      obs.push(o.id);
    }

    const result = service.timeline(obs[2], 2, 2);
    expect(result.entries.length).toBe(5); // 2 before + anchor + 2 after
    expect(result.entries.find((e) => e.isAnchor)?.id).toBe(obs[2]);
  });

  it("should filter timeline by project", () => {
    const baseTime = Date.now() - 50000;
    service.addObservation(makeObservation({
      projectPath: "/proj/a",
      title: "A1",
      timestamp: baseTime,
    }));
    const anchor = service.addObservation(makeObservation({
      projectPath: "/proj/a",
      title: "A2",
      timestamp: baseTime + 10000,
    }));
    service.addObservation(makeObservation({
      projectPath: "/proj/b",
      title: "B1",
      timestamp: baseTime + 20000,
    }));

    const result = service.timeline(anchor.id, 5, 5, "/proj/a");
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("A1");
    expect(titles).toContain("A2");
    expect(titles).not.toContain("B1");
  });
});

describe("memory_get tool logic", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should return empty for nonexistent IDs", () => {
    const obs = service.getObservations([999, 1000]);
    expect(obs).toEqual([]);
  });

  it("should return full observation details", () => {
    const created = service.addObservation(makeObservation({
      title: "Full detail test",
      content: "Very detailed content here",
      tags: ["tag1", "tag2"],
      filePaths: ["/src/foo.ts"],
    }));

    const obs = service.getObservations([created.id]);
    expect(obs.length).toBe(1);
    expect(obs[0].title).toBe("Full detail test");
    expect(obs[0].content).toBe("Very detailed content here");
    expect(obs[0].tags).toEqual(["tag1", "tag2"]);
    expect(obs[0].filePaths).toEqual(["/src/foo.ts"]);
  });

  it("should return multiple observations", () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const o = service.addObservation(makeObservation({ title: `Obs ${i}` }));
      ids.push(o.id);
    }

    const obs = service.getObservations(ids);
    expect(obs.length).toBe(3);
  });
});

describe("memory_save tool logic", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should save an observation", () => {
    const obs = service.addObservation({
      sessionId: "mcp-test",
      projectPath: "/test",
      timestamp: Date.now(),
      type: "decision",
      title: "Use repository pattern",
      content: "Decided to use repository pattern for data access",
      filePaths: [],
      tags: ["architecture"],
      metadata: { source: "mcp-tool" },
    });

    expect(obs.id).toBeGreaterThan(0);
    expect(obs.title).toBe("Use repository pattern");
    expect(obs.type).toBe("decision");
  });

  it("should be retrievable after save", () => {
    const obs = service.addObservation(makeObservation({
      title: "Retrievable observation",
    }));

    const retrieved = service.getObservation(obs.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Retrievable observation");
  });
});

describe("memory_stats tool logic", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should return stats for empty database", () => {
    const stats = service.getStats();
    expect(stats.totalObservations).toBe(0);
    expect(stats.totalSessions).toBe(0);
  });

  it("should return accurate stats after adding observations", () => {
    service.addObservation(makeObservation({ type: "decision" }));
    service.addObservation(makeObservation({ type: "decision" }));
    service.addObservation(makeObservation({ type: "error" }));

    const stats = service.getStats();
    expect(stats.totalObservations).toBe(3);
    expect(stats.byType.decision).toBe(2);
    expect(stats.byType.error).toBe(1);
  });

  it("should track observations by project", () => {
    service.addObservation(makeObservation({ projectPath: "/proj/a" }));
    service.addObservation(makeObservation({ projectPath: "/proj/a" }));
    service.addObservation(makeObservation({ projectPath: "/proj/b" }));

    const stats = service.getStats();
    expect(stats.byProject["/proj/a"]).toBe(2);
    expect(stats.byProject["/proj/b"]).toBe(1);
  });
});
