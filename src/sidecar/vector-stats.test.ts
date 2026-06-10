/**
 * Vector Stats Helper Tests
 *
 * buildVectorStats: maps VectorSearchState -> MemoryStats.vector payload.
 * notifyVectorUnavailableOnce: one-time notification guarded by a settings key.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SETUP_HINT } from "../memory/native-deps.js";
import type { VectorStore } from "../memory/vector-store.js";
import type { VectorSearchState } from "./server.js";
import {
  buildVectorStats,
  notifyVectorUnavailableOnce,
  VECTOR_DEPS_NOTIFIED_KEY,
} from "./vector-stats.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-vector-stats-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockVectorStore(count: number): VectorStore {
  return { getVectorCount: () => count } as unknown as VectorStore;
}

describe("buildVectorStats", () => {
  it("maps ready state with vector count", () => {
    const state: VectorSearchState = {
      status: "ready",
      vectorStore: mockVectorStore(42),
    };
    expect(buildVectorStats(state)).toEqual({
      status: "ready",
      count: 42,
      initError: null,
      hint: null,
    });
  });

  it("maps unavailable state with error and setup hint", () => {
    const state: VectorSearchState = {
      status: "unavailable",
      error: "sqlite-vec not available",
    };
    expect(buildVectorStats(state)).toEqual({
      status: "unavailable",
      count: 0,
      initError: "sqlite-vec not available",
      hint: SETUP_HINT,
    });
  });

  it("maps initializing state", () => {
    expect(buildVectorStats({ status: "initializing" })).toEqual({
      status: "initializing",
      count: 0,
      initError: null,
      hint: null,
    });
  });

  it("maps disabled state", () => {
    expect(buildVectorStats({ status: "disabled" })).toEqual({
      status: "disabled",
      count: 0,
      initError: null,
      hint: null,
    });
  });
});

describe("notifyVectorUnavailableOnce", () => {
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

  it("inserts a warning notification with the setup hint on first call", () => {
    const inserted = notifyVectorUnavailableOnce(
      store,
      "sqlite-vec not available",
    );
    expect(inserted).toBe(true);

    const notifications = store.getNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.type).toBe("warning");
    expect(notifications[0]!.title).toBe("Vector search unavailable");
    expect(notifications[0]!.message).toContain("sqlite-vec not available");
    expect(notifications[0]!.message).toContain(SETUP_HINT);
  });

  it("does not insert a second notification on subsequent calls", () => {
    expect(notifyVectorUnavailableOnce(store, "err")).toBe(true);
    expect(notifyVectorUnavailableOnce(store, "err")).toBe(false);
    expect(notifyVectorUnavailableOnce(store, "other err")).toBe(false);
    expect(store.getNotifications().length).toBe(1);
  });

  it("guards via the vector_deps_notified settings key", () => {
    expect(store.getSetting(VECTOR_DEPS_NOTIFIED_KEY)).toBeNull();
    notifyVectorUnavailableOnce(store, "err");
    expect(store.getSetting(VECTOR_DEPS_NOTIFIED_KEY)).not.toBeNull();
  });

  it("respects a pre-existing settings key (no notification)", () => {
    store.setSetting(VECTOR_DEPS_NOTIFIED_KEY, String(Date.now()));
    expect(notifyVectorUnavailableOnce(store, "err")).toBe(false);
    expect(store.getNotifications().length).toBe(0);
  });
});
