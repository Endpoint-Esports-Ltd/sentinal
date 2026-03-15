/**
 * Database Maintenance Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { rebuildFtsIndex, backupDatabase, checkIntegrity, decayQualityScores } from "./maintenance.js";
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

// ─── Quality Decay ────────────────────────────────────────────────────────────

describe("decayQualityScores", () => {
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
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  it("should decay scores based on observation age and type", () => {
    const now = Date.now();
    // 60 days old = 2 decay periods
    service.addObservation(makeObservation({
      type: "decision",
      timestamp: now - 2 * THIRTY_DAYS_MS,
      title: "Old decision",
    }));
    service.addObservation(makeObservation({
      type: "error",
      timestamp: now - 2 * THIRTY_DAYS_MS,
      title: "Old error",
    }));

    const result = decayQualityScores(store);

    expect(result.updated).toBeGreaterThan(0);

    // Check actual scores: decision decays slower than error
    const decision = store.getObservation(1);
    const error = store.getObservation(2);

    // decision: 1.0 * 0.95^2 = 0.9025
    expect(decision!.qualityScore).toBeCloseTo(0.9025, 2);
    // error: 1.0 * 0.75^2 = 0.5625
    expect(error!.qualityScore).toBeCloseTo(0.5625, 2);
  });

  it("should not decay recent observations", () => {
    service.addObservation(makeObservation({
      type: "error",
      timestamp: Date.now(),
      title: "Fresh error",
    }));

    decayQualityScores(store);

    const obs = store.getObservation(1);
    // Score should be very close to 1.0 (within hours, not 30 days)
    expect(obs!.qualityScore).toBeGreaterThan(0.99);
  });

  it("should enforce minimum score of 0.1", () => {
    // 365 days old = 12+ decay periods — error type decays fast
    const now = Date.now();
    service.addObservation(makeObservation({
      type: "error",
      timestamp: now - 365 * 24 * 60 * 60 * 1000,
      title: "Very old error",
    }));

    decayQualityScores(store);

    const obs = store.getObservation(1);
    // 0.75^12 ≈ 0.032 → clamped to 0.1
    expect(obs!.qualityScore).toBeCloseTo(0.1, 2);
  });

  it("should apply different rates per type", () => {
    const now = Date.now();
    const age = now - THIRTY_DAYS_MS; // exactly 1 period

    service.addObservation(makeObservation({ type: "decision", timestamp: age, title: "D" }));
    service.addObservation(makeObservation({ type: "discovery", timestamp: age, title: "Disc" }));
    service.addObservation(makeObservation({ type: "pattern", timestamp: age, title: "P" }));
    service.addObservation(makeObservation({ type: "fix", timestamp: age, title: "F" }));
    service.addObservation(makeObservation({ type: "error", timestamp: age, title: "E" }));

    decayQualityScores(store);

    const d = store.getObservation(1)!;
    const disc = store.getObservation(2)!;
    const p = store.getObservation(3)!;
    const f = store.getObservation(4)!;
    const e = store.getObservation(5)!;

    // After 1 period: score = 1.0 * rate
    expect(d.qualityScore).toBeCloseTo(0.95, 2);
    expect(disc.qualityScore).toBeCloseTo(0.90, 2);
    expect(p.qualityScore).toBeCloseTo(0.85, 2);
    expect(f.qualityScore).toBeCloseTo(0.80, 2);
    expect(e.qualityScore).toBeCloseTo(0.75, 2);
  });

  it("should support dry_run mode", () => {
    const now = Date.now();
    service.addObservation(makeObservation({
      type: "error",
      timestamp: now - 2 * THIRTY_DAYS_MS,
      title: "Old error",
    }));

    const result = decayQualityScores(store, { dryRun: true });

    expect(result.updated).toBe(0);
    expect(result.decayed).toBeGreaterThan(0);

    // Score should be unchanged
    const obs = store.getObservation(1);
    expect(obs!.qualityScore).toBe(1.0);
  });

  it("should return counts of updated and decayed observations", () => {
    const now = Date.now();
    service.addObservation(makeObservation({
      type: "decision",
      timestamp: now - THIRTY_DAYS_MS,
      title: "Old",
    }));
    service.addObservation(makeObservation({
      type: "fix",
      timestamp: now, // fresh — won't decay significantly
      title: "New",
    }));

    const result = decayQualityScores(store);

    expect(typeof result.updated).toBe("number");
    expect(typeof result.decayed).toBe("number");
  });

  it("should never boost quality_score above its initial value", () => {
    const now = Date.now();
    // Insert with low confidence (quality_score = 0.6)
    service.addObservation(makeObservation({
      type: "error",
      timestamp: now - 10 * 24 * 60 * 60 * 1000, // 10 days old
      title: "Low confidence error",
      metadata: { confidence: 0.6 },
    }));

    decayQualityScores(store);

    const obs = store.getObservation(1)!;
    // 0.75^(10/30) ≈ 0.91 — but initial was 0.6
    // Should NOT boost to 0.91, should stay <= 0.6
    expect(obs.qualityScore).toBeLessThanOrEqual(0.6);
  });
});
