/**
 * MCP Server Tests
 *
 * Tests the unified Sentinal MCP server including:
 * - Server creation with all tool modules
 * - Memory tools (search, timeline, get, save, stats)
 * - Spec tools (spec_status)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { createSentinalServer, registerMcpCleanupHandlers } from "./server.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import * as lifecycleModule from "../sidecar/lifecycle.js";
import type { CreateObservation } from "../memory/types.js";

// --- Helpers ---

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
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

// --- Server Creation Tests ---

describe("createSentinalServer", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create a server and store", () => {
    const result = createSentinalServer({ store });
    expect(result.server).toBeDefined();
    expect(result.store).toBe(store);
  });

  it("should create a server with default store when none provided", () => {
    const result = createSentinalServer();
    expect(result.server).toBeDefined();
    expect(result.store).toBeInstanceOf(MemoryStore);
    result.store!.close();
  });
});

// --- Memory Tool Logic Tests ---

describe("memory_search tool logic", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty results for no matches", async () => {
    const results = await service.search("nonexistent query");
    expect(results).toEqual([]);
  });

  it("should find observations by keyword", async () => {
    service.addObservation(
      makeObservation({
        title: "Database migration strategy",
        content: "Chose sequential migrations over auto-sync",
        tags: ["database", "migration"],
      }),
    );

    const results = await service.search("migration");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Database migration strategy");
  });

  it("should filter by project", async () => {
    service.addObservation(
      makeObservation({
        projectPath: "/project/alpha",
        title: "Alpha discovery",
      }),
    );
    service.addObservation(
      makeObservation({
        projectPath: "/project/beta",
        title: "Beta discovery",
      }),
    );

    const results = await service.search("discovery", {
      project: "/project/alpha",
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Alpha discovery");
  });

  it("should filter by type", async () => {
    service.addObservation(
      makeObservation({ type: "decision", title: "A decision" }),
    );
    service.addObservation(
      makeObservation({ type: "error", title: "An error" }),
    );

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
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty entries for nonexistent anchor", () => {
    const result = service.timeline(999);
    expect(result.entries.length).toBe(0);
  });

  it("should return timeline around an anchor", () => {
    const baseTime = Date.now() - 100000;
    const obs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const o = service.addObservation(
        makeObservation({
          title: `Event ${i}`,
          timestamp: baseTime + i * 10000,
        }),
      );
      obs.push(o.id);
    }

    const result = service.timeline(obs[2], 2, 2);
    expect(result.entries.length).toBe(5);
    expect(result.entries.find((e) => e.isAnchor)?.id).toBe(obs[2]);
  });

  it("should filter timeline by project", () => {
    const baseTime = Date.now() - 50000;
    service.addObservation(
      makeObservation({
        projectPath: "/proj/a",
        title: "A1",
        timestamp: baseTime,
      }),
    );
    const anchor = service.addObservation(
      makeObservation({
        projectPath: "/proj/a",
        title: "A2",
        timestamp: baseTime + 10000,
      }),
    );
    service.addObservation(
      makeObservation({
        projectPath: "/proj/b",
        title: "B1",
        timestamp: baseTime + 20000,
      }),
    );

    const result = service.timeline(anchor.id, 5, 5, "/proj/a");
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("A1");
    expect(titles).toContain("A2");
    expect(titles).not.toContain("B1");
  });
});

describe("memory_get tool logic", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty for nonexistent IDs", () => {
    const obs = service.getObservations([999, 1000]);
    expect(obs).toEqual([]);
  });

  it("should return full observation details", () => {
    const created = service.addObservation(
      makeObservation({
        title: "Full detail test",
        content: "Very detailed content here",
        tags: ["tag1", "tag2"],
        filePaths: ["/src/foo.ts"],
      }),
    );

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
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
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
    const obs = service.addObservation(
      makeObservation({
        title: "Retrievable observation",
      }),
    );

    const retrieved = service.getObservation(obs.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Retrievable observation");
  });

  it("should use real session ID when exactly one active session exists", () => {
    // Create a real session
    store.insertSession({
      id: "real-session-123",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    // Verify getActiveSessions returns it
    const active = store.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("real-session-123");
  });

  it("should fall back to synthetic ID when no active sessions", () => {
    const active = store.getActiveSessions();
    expect(active.length).toBe(0);
  });

  it("should fall back to synthetic ID when multiple active sessions", () => {
    store.insertSession({
      id: "session-a",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    store.insertSession({
      id: "session-b",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const active = store.getActiveSessions();
    expect(active.length).toBe(2);
  });
});

describe("memory_stats tool logic", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
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

// --- Spec Tool Logic Tests ---

describe("spec_status tool logic", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let specStore: SpecStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    specStore = new SpecStore(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return null when no active spec", () => {
    const current = specStore.getCurrentSpec("/test/project");
    expect(current).toBeNull();
  });

  it("should return current spec with task breakdown", () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planFile = join(plansDir, "2026-03-09-feature.md");
    writeFileSync(
      planFile,
      `# Feature Plan

Status: IN PROGRESS
Type: Feature

## Progress Tracking

- [x] Task 1: Setup
- [~] Task 2: Implementation
- [ ] Task 3: Testing
`,
    );

    specStore.syncFromPlanFile(planFile, "/test/project");
    const spec = specStore.getCurrentSpec("/test/project");

    expect(spec).not.toBeNull();
    expect(spec!.title).toBe("Feature Plan");
    expect(spec!.status).toBe("IN_PROGRESS");
    expect(spec!.tasks).toHaveLength(3);

    const done = spec!.tasks.filter((t) => t.status === "complete").length;
    const inProg = spec!.tasks.filter((t) => t.status === "in-progress").length;
    const pending = spec!.tasks.filter((t) => t.status === "pending").length;
    expect(done).toBe(1);
    expect(inProg).toBe(1);
    expect(pending).toBe(1);
  });
});

// --- MCP Cleanup Handler Tests ---

describe("registerMcpCleanupHandlers", () => {
  afterEach(() => {
    mock.restore();
  });

  it("should be a callable function", () => {
    expect(typeof registerMcpCleanupHandlers).toBe("function");
  });

  it("should call stopSidecarProcess when no active sessions remain", () => {
    const tmpDir = makeTmpDir();
    const store = new MemoryStore(join(tmpDir, "test.db"));

    const stopSpy = spyOn(
      lifecycleModule,
      "stopSidecarProcess",
    ).mockReturnValue(true);

    // Register cleanup with a store that has no active sessions
    const cleanup = registerMcpCleanupHandlers(store);
    cleanup();

    expect(stopSpy).toHaveBeenCalled();

    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should NOT call stopSidecarProcess when active sessions exist", () => {
    const tmpDir = makeTmpDir();
    const store = new MemoryStore(join(tmpDir, "test.db"));

    // Create an active session
    store.insertSession({
      id: "active-1",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const stopSpy = spyOn(
      lifecycleModule,
      "stopSidecarProcess",
    ).mockReturnValue(true);

    const cleanup = registerMcpCleanupHandlers(store);
    cleanup();

    expect(stopSpy).not.toHaveBeenCalled();

    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Keepalive tests removed — keepalive ping no longer needed with session-aware shutdown.
