/**
 * CLI Tests
 *
 * Tests the memory CLI command functions directly
 * using an in-memory database for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import type { CreateObservation } from "./types.js";
import {
  parseArgs,
  runSearch,
  runList,
  runTimeline,
  runGet,
  runExport,
  runStats,
  runPrune,
} from "./cli.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDb(): string {
  const dir = join(
    tmpdir(),
    `sentinal-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ─── parseArgs ───────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("should parse command and positional args", () => {
    const result = parseArgs(["search", "auth", "token"]);
    expect(result.command).toBe("search");
    expect(result.positional).toEqual(["auth", "token"]);
  });

  it("should parse flags", () => {
    const result = parseArgs(["list", "--project", "/test", "--limit", "5"]);
    expect(result.command).toBe("list");
    expect(result.flags.project).toBe("/test");
    expect(result.flags.limit).toBe("5");
  });

  it("should handle boolean flags", () => {
    const result = parseArgs(["export", "--verbose"]);
    expect(result.flags.verbose).toBe("true");
  });

  it("should default to help with no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
  });
});

// ─── Command Tests ───────────────────────────────────────────────────────────

describe("runSearch", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should show usage when no query", async () => {
    const result = await runSearch(service, {
      command: "search",
      positional: [],
      flags: {},
    });
    expect(result).toContain("Usage:");
  });

  it("should find matching observations", async () => {
    service.addObservation(makeObservation({ title: "Database migration" }));
    const result = await runSearch(service, {
      command: "search",
      positional: ["migration"],
      flags: {},
    });
    expect(result).toContain("Database migration");
  });

  it("should report no matches", async () => {
    const result = await runSearch(service, {
      command: "search",
      positional: ["nonexistent"],
      flags: {},
    });
    expect(result).toContain("No matching");
  });
});

describe("runList", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should list recent observations", async () => {
    service.addObservation(makeObservation({ title: "First item" }));
    service.addObservation(makeObservation({ title: "Second item" }));
    const result = await runList(service, {
      command: "list",
      positional: [],
      flags: {},
    });
    expect(result).toContain("First item");
    expect(result).toContain("Second item");
  });

  it("should filter by type", async () => {
    service.addObservation(
      makeObservation({ type: "decision", title: "A decision" }),
    );
    service.addObservation(
      makeObservation({ type: "error", title: "An error" }),
    );
    const result = await runList(service, {
      command: "list",
      positional: [],
      flags: { type: "decision" },
    });
    expect(result).toContain("A decision");
    expect(result).not.toContain("An error");
  });
});

describe("runTimeline", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should show usage when no anchor", () => {
    const result = runTimeline(service, {
      command: "timeline",
      positional: [],
      flags: {},
    });
    expect(result).toContain("Usage:");
  });

  it("should show timeline around anchor", () => {
    const base = Date.now() - 100000;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const o = service.addObservation(
        makeObservation({
          title: `Event ${i}`,
          timestamp: base + i * 10000,
        }),
      );
      ids.push(o.id);
    }

    const result = runTimeline(service, {
      command: "timeline",
      positional: [],
      flags: { anchor: String(ids[2]) },
    });
    expect(result).toContain(">>>");
    expect(result).toContain(`Event 2`);
  });

  it("should accept anchor as positional arg", () => {
    const o = service.addObservation(makeObservation({ title: "Solo event" }));
    const result = runTimeline(service, {
      command: "timeline",
      positional: [String(o.id)],
      flags: {},
    });
    expect(result).toContain("Solo event");
  });
});

describe("runGet", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should show usage when no IDs", () => {
    const result = runGet(service, {
      command: "get",
      positional: [],
      flags: {},
    });
    expect(result).toContain("Usage:");
  });

  it("should show full observation", () => {
    const o = service.addObservation(
      makeObservation({
        title: "Full detail",
        content: "Detailed content here",
        tags: ["tag1"],
      }),
    );
    const result = runGet(service, {
      command: "get",
      positional: [String(o.id)],
      flags: {},
    });
    expect(result).toContain("Full detail");
    expect(result).toContain("Detailed content here");
    expect(result).toContain("tag1");
  });

  it("should handle multiple IDs", () => {
    const o1 = service.addObservation(makeObservation({ title: "Obs A" }));
    const o2 = service.addObservation(makeObservation({ title: "Obs B" }));
    const result = runGet(service, {
      command: "get",
      positional: [String(o1.id), String(o2.id)],
      flags: {},
    });
    expect(result).toContain("Obs A");
    expect(result).toContain("Obs B");
  });
});

describe("runExport", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should export as JSON", () => {
    service.addObservation(makeObservation({ title: "Export test" }));
    const result = runExport(service, {
      command: "export",
      positional: [],
      flags: {},
    });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("Export test");
  });

  it("should export as markdown", () => {
    service.addObservation(makeObservation({ title: "MD export" }));
    const result = runExport(service, {
      command: "export",
      positional: [],
      flags: { format: "markdown" },
    });
    expect(result).toContain("## MD export");
  });

  it("should export filtered by project", () => {
    service.addObservation(
      makeObservation({ projectPath: "/proj/a", title: "A obs" }),
    );
    service.addObservation(
      makeObservation({ projectPath: "/proj/b", title: "B obs" }),
    );
    const result = runExport(service, {
      command: "export",
      positional: [],
      flags: { project: "/proj/a" },
    });
    const parsed = JSON.parse(result);
    expect(parsed.length).toBe(1);
    expect(parsed[0].title).toBe("A obs");
  });
});

describe("runStats", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should show stats for empty db", () => {
    const result = runStats(service);
    expect(result).toContain("Total Observations: 0");
  });

  it("should show accurate counts", () => {
    service.addObservation(makeObservation({ type: "decision" }));
    service.addObservation(makeObservation({ type: "error" }));
    const result = runStats(service);
    expect(result).toContain("Total Observations: 2");
    expect(result).toContain("decision: 1");
    expect(result).toContain("error: 1");
  });
});

describe("runPrune", () => {
  let dbPath: string;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    service = new MemoryService(new MemoryStore(dbPath));
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should report invalid duration", () => {
    const result = runPrune(service, {
      command: "prune",
      positional: [],
      flags: { "older-than": "abc" },
    });
    expect(result).toContain("Invalid duration");
  });

  it("should prune old observations", () => {
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago
    service.addObservation(
      makeObservation({ timestamp: oldTime, title: "Old obs" }),
    );
    service.addObservation(makeObservation({ title: "Recent obs" }));

    const result = runPrune(service, {
      command: "prune",
      positional: [],
      flags: { "older-than": "90d" },
    });
    expect(result).toContain("Pruned 1");
  });

  it("should report when nothing to prune", () => {
    service.addObservation(makeObservation({ title: "Recent" }));
    const result = runPrune(service, {
      command: "prune",
      positional: [],
      flags: { "older-than": "90d" },
    });
    expect(result).toContain("No observations");
  });
});
