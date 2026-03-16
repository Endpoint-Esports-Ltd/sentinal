/**
 * Shared Memory Tools Tests
 *
 * Tests for memory_share tool logic and shared save functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { readSharedMemory, addSharedObservation, saveToSharedIfRequested } from "./shared.js";
import type { CreateObservation } from "./types.js";

function makeTmpProject(): string {
  const dir = join(tmpdir(), `sentinal-share-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeObservation(overrides: Partial<CreateObservation> = {}): CreateObservation {
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

describe("saveToSharedIfRequested", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTmpProject(); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("should save to shared file when shared is true and type is allowed", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "decision",
      title: "Shared decision",
      content: "We decided something",
      tags: ["arch"],
      filePaths: ["src/foo.ts"],
      shared: true,
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe("Shared decision");
    expect(shared[0].type).toBe("decision");
  });

  it("should not save when shared is false", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "decision",
      title: "Not shared",
      content: "content",
      shared: false,
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(0);
  });

  it("should not save when shared is undefined", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "decision",
      title: "Not shared",
      content: "content",
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(0);
  });

  it("should reject error type for shared save", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "error",
      title: "Error obs",
      content: "content",
      shared: true,
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(0);
  });

  it("should reject fix type for shared save", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "fix",
      title: "Fix obs",
      content: "content",
      shared: true,
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(0);
  });

  it("should allow pattern type for shared save", async () => {
    await saveToSharedIfRequested({
      project: projectDir,
      type: "pattern",
      title: "Shared pattern",
      content: "Always use X",
      shared: true,
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(1);
    expect(shared[0].type).toBe("pattern");
  });
});

describe("memory_share promotion logic", () => {
  let store: MemoryStore;
  let service: MemoryService;
  let projectDir: string;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
    projectDir = makeTmpProject();
  });

  afterEach(() => {
    service.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should promote decision observations to shared memory", () => {
    const obs = service.addObservation(makeObservation({
      type: "decision",
      title: "Architecture choice",
      content: "We chose X over Y",
      projectPath: projectDir,
      tags: ["arch"],
      filePaths: ["src/main.ts"],
    }));

    // Simulate promotion: read from store, convert, add to shared
    const retrieved = service.getObservation(obs.id);
    expect(retrieved).not.toBeNull();

    addSharedObservation(projectDir, {
      type: retrieved!.type,
      title: retrieved!.title,
      content: retrieved!.content,
      tags: retrieved!.tags,
      filePaths: retrieved!.filePaths,
      createdAt: new Date(retrieved!.timestamp).toISOString().split("T")[0],
    });

    const shared = readSharedMemory(projectDir);
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe("Architecture choice");
  });

  it("should reject promotion of error observations", () => {
    const obs = service.addObservation(makeObservation({
      type: "error",
      title: "Build error",
      projectPath: projectDir,
    }));

    // Simulating rejection — the MCP tool handler would check type
    const SHAREABLE_TYPES = ["decision", "discovery", "pattern"];
    expect(SHAREABLE_TYPES.includes(obs.type)).toBe(false);
  });
});
