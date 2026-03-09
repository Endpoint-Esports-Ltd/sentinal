/**
 * Database Maintenance Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { rebuildFtsIndex, backupDatabase, checkIntegrity } from "./maintenance.js";
import type { CreateObservation } from "./types.js";

function makeTmpDb(): string {
  const dir = join(tmpdir(), `sentinal-maint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    content: "Some test content",
    filePaths: [],
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

// ─── FTS Rebuild ──────────────────────────────────────────────────────────────

describe("rebuildFtsIndex", () => {
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

  it("should rebuild FTS index for empty database", () => {
    const count = rebuildFtsIndex(store);
    expect(count).toBe(0);
  });

  it("should rebuild FTS index with existing observations", () => {
    service.addObservation(makeObservation({ title: "First obs" }));
    service.addObservation(makeObservation({ title: "Second obs" }));
    service.addObservation(makeObservation({ title: "Third obs" }));

    const count = rebuildFtsIndex(store);
    expect(count).toBe(3);
  });

  it("should restore search functionality after rebuild", async () => {
    service.addObservation(makeObservation({
      title: "Database migration strategy",
      content: "Chose sequential migrations",
    }));

    rebuildFtsIndex(store);

    const results = await service.search("migration");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Database migration strategy");
  });
});

// ─── Backup ───────────────────────────────────────────────────────────────────

describe("backupDatabase", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    // Create a real database file
    const store = new MemoryStore(dbPath);
    store.close();
  });

  afterEach(() => {
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}.bak`, { force: true });
    } catch {}
  });

  it("should create a backup file", () => {
    const backupPath = backupDatabase(dbPath);
    expect(backupPath).not.toBeNull();
    expect(existsSync(backupPath!)).toBe(true);
  });

  it("should return null for in-memory database", () => {
    const result = backupDatabase(":memory:");
    expect(result).toBeNull();
  });

  it("should return null for non-existent file", () => {
    const result = backupDatabase("/nonexistent/path/db.sqlite");
    expect(result).toBeNull();
  });

  it("should create backup with .bak extension", () => {
    const backupPath = backupDatabase(dbPath);
    expect(backupPath).toBe(`${dbPath}.bak`);
  });
});

// ─── Integrity Check ──────────────────────────────────────────────────────────

describe("checkIntegrity", () => {
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(() => {
    dbPath = makeTmpDb();
    store = new MemoryStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should return null for healthy database", () => {
    const result = checkIntegrity(store);
    expect(result).toBeNull();
  });

  it("should return null after adding observations", () => {
    const service = new MemoryService(store);
    service.addObservation(makeObservation());
    service.addObservation(makeObservation());

    const result = checkIntegrity(store);
    expect(result).toBeNull();
  });
});
