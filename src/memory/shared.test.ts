/**
 * Shared Memory Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSharedMemory,
  writeSharedMemory,
  addSharedObservation,
  sharedMemoryPath,
  toObservation,
  type SharedObservation,
} from "./shared.js";

function makeTmpProject(): string {
  const dir = join(tmpdir(), `sentinal-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSharedObs(overrides: Partial<SharedObservation> = {}): SharedObservation {
  return {
    type: "decision",
    title: "Test shared observation",
    content: "Some shared content",
    tags: ["test"],
    filePaths: [],
    createdAt: "2026-03-15",
    ...overrides,
  };
}

describe("sharedMemoryPath", () => {
  it("should return path inside .sentinal directory", () => {
    const path = sharedMemoryPath("/my/project");
    expect(path).toBe("/my/project/.sentinal/project-memory.json");
  });
});

describe("readSharedMemory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTmpProject(); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("should return empty array when file does not exist", () => {
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });

  it("should return empty array on invalid JSON", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(sharedMemoryPath(projectDir), "not valid json{{{");
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });

  it("should parse valid shared memory file", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(sharedMemoryPath(projectDir), JSON.stringify({
      version: 1,
      observations: [
        makeSharedObs({ title: "First" }),
        makeSharedObs({ title: "Second", type: "pattern" }),
      ],
    }, null, 2));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("First");
    expect(result[1].type).toBe("pattern");
  });

  it("should return empty array when observations field is missing", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(sharedMemoryPath(projectDir), JSON.stringify({ version: 1 }));
    const result = readSharedMemory(projectDir);
    expect(result).toEqual([]);
  });
});

describe("writeSharedMemory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTmpProject(); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("should create .sentinal directory and write formatted JSON", () => {
    const obs = [makeSharedObs({ title: "Written" })];
    writeSharedMemory(projectDir, obs);

    const raw = readFileSync(sharedMemoryPath(projectDir), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].title).toBe("Written");
    // Should be formatted (2-space indent)
    expect(raw).toContain("  ");
  });

  it("should overwrite existing file", () => {
    writeSharedMemory(projectDir, [makeSharedObs({ title: "First" })]);
    writeSharedMemory(projectDir, [makeSharedObs({ title: "Second" })]);

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Second");
  });
});

describe("addSharedObservation", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTmpProject(); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("should add observation to empty file", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "New obs" }));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("New obs");
  });

  it("should append to existing observations", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "First" }));
    addSharedObservation(projectDir, makeSharedObs({ title: "Second" }));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(2);
  });

  it("should deduplicate by title", () => {
    addSharedObservation(projectDir, makeSharedObs({ title: "Same title" }));
    addSharedObservation(projectDir, makeSharedObs({ title: "Same title", content: "Updated" }));

    const result = readSharedMemory(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Updated");
  });
});

describe(".sentinal/.gitignore", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTmpProject(); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("should create .gitignore when writing shared memory", () => {
    writeSharedMemory(projectDir, [makeSharedObs()]);

    const gitignorePath = join(projectDir, ".sentinal", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toContain("*");
    expect(content).toContain("!.gitignore");
    expect(content).toContain("!project-memory.json");
  });

  it("should not overwrite existing .gitignore", () => {
    mkdirSync(join(projectDir, ".sentinal"), { recursive: true });
    writeFileSync(join(projectDir, ".sentinal", ".gitignore"), "custom content\n");

    writeSharedMemory(projectDir, [makeSharedObs()]);

    const content = readFileSync(join(projectDir, ".sentinal", ".gitignore"), "utf-8");
    expect(content).toBe("custom content\n");
  });
});

describe("toObservation", () => {
  it("should convert SharedObservation to full Observation", () => {
    const shared = makeSharedObs({
      title: "Converted",
      type: "pattern",
      createdAt: "2026-03-15",
    });

    const obs = toObservation(shared, "/test/project", 0);

    expect(obs.id).toBe(-1);
    expect(obs.sessionId).toBe("shared");
    expect(obs.projectPath).toBe("/test/project");
    expect(obs.type).toBe("pattern");
    expect(obs.title).toBe("Converted");
    expect(obs.timestamp).toBeGreaterThan(0);
    expect(obs.metadata).toEqual({ source: "shared" });
    expect(obs.qualityScore).toBe(1.0);
  });

  it("should generate sequential negative IDs", () => {
    const shared = makeSharedObs();
    const obs0 = toObservation(shared, "/test", 0);
    const obs1 = toObservation(shared, "/test", 1);
    const obs2 = toObservation(shared, "/test", 2);

    expect(obs0.id).toBe(-1);
    expect(obs1.id).toBe(-2);
    expect(obs2.id).toBe(-3);
  });
});
