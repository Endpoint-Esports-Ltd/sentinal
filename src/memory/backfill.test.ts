/**
 * Observation Vector Backfill Tests
 *
 * Tests backfilling vectors for observations that were saved before
 * vector search initialized. Uses a REAL vec0 table (via test preload's
 * Homebrew SQLite + sqlite-vec) to cover the aux-column DISTINCT path.
 * Skips gracefully if sqlite-vec is unavailable.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { MemoryStore } from "./store.js";
import { VectorStore, loadCustomSqlite } from "./vector-store.js";
import { EmbeddingService } from "./embeddings.js";
import { backfillVectors } from "./backfill.js";
import type { CreateObservation, Observation } from "./types.js";

// Must run before any Database instance is created
loadCustomSqlite();

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "session-1",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "This is a test observation content",
    filePaths: [],
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

describe("backfillVectors", () => {
  let embeddings: EmbeddingService;
  let store: MemoryStore;
  let vectorStore: VectorStore;
  let available: boolean;

  beforeAll(async () => {
    embeddings = new EmbeddingService();
    await embeddings.initialize();
  });

  beforeEach(async () => {
    store = new MemoryStore(":memory:");
    vectorStore = new VectorStore(store.getRawDb(), embeddings);
    await vectorStore.initialize();
    available = vectorStore.isAvailable() && embeddings.isAvailable();
    if (!available) {
      console.warn(
        "VectorStore not available, skipping backfill tests. Error:",
        vectorStore.getInitError() ?? embeddings.getInitError(),
      );
    }
  });

  afterEach(() => {
    store.close();
  });

  async function indexDirectly(obs: Observation): Promise<void> {
    await vectorStore.indexObservation(
      obs.id,
      obs.title,
      obs.content,
      obs.tags,
      obs.projectPath,
      obs.timestamp,
    );
  }

  it("indexes only observations missing vectors (DISTINCT over vec0 aux column)", async () => {
    if (!available) return;

    const obs1 = store.insertObservation(
      makeObservation({ title: "Already indexed" }),
    );
    store.insertObservation(makeObservation({ title: "Missing one" }));
    store.insertObservation(makeObservation({ title: "Missing two" }));

    // Pre-index the first observation — backfill must skip it
    await indexDirectly(obs1);
    const countBefore = vectorStore.getVectorCount();

    const result = await backfillVectors(store, vectorStore, undefined, {
      delayMs: 0,
    });

    expect(result.scanned).toBe(2);
    expect(result.indexed).toBe(2);
    // Each backfilled observation: title + content + 1 tag = 3 vectors
    expect(vectorStore.getVectorCount()).toBe(countBefore + 6);
  }, 30_000);

  it("is idempotent — second run indexes nothing", async () => {
    if (!available) return;

    store.insertObservation(makeObservation({ title: "First" }));
    store.insertObservation(makeObservation({ title: "Second" }));

    const first = await backfillVectors(store, vectorStore, undefined, {
      delayMs: 0,
    });
    expect(first.indexed).toBe(2);

    const countAfterFirst = vectorStore.getVectorCount();
    const second = await backfillVectors(store, vectorStore, undefined, {
      delayMs: 0,
    });

    expect(second.scanned).toBe(0);
    expect(second.indexed).toBe(0);
    expect(vectorStore.getVectorCount()).toBe(countAfterFirst);
  }, 30_000);

  it("logs start and end with counts", async () => {
    if (!available) return;

    store.insertObservation(makeObservation({ title: "Log one" }));
    store.insertObservation(makeObservation({ title: "Log two" }));

    const logs: string[] = [];
    await backfillVectors(store, vectorStore, (msg) => logs.push(msg), {
      delayMs: 0,
    });

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toContain("backfill");
    expect(logs[0]).toContain("2");
    expect(logs[logs.length - 1]).toContain("indexed 2");
  }, 30_000);

  it("respects the delayMs pacing option between observations", async () => {
    if (!available) return;

    store.insertObservation(makeObservation({ title: "Pace one" }));
    store.insertObservation(makeObservation({ title: "Pace two" }));
    store.insertObservation(makeObservation({ title: "Pace three" }));

    const start = performance.now();
    const result = await backfillVectors(store, vectorStore, undefined, {
      delayMs: 40,
    });
    const elapsed = performance.now() - start;

    expect(result.indexed).toBe(3);
    // 3 observations → at least 2 inter-item delays of 40ms
    expect(elapsed).toBeGreaterThanOrEqual(70);
  }, 30_000);

  it("returns zeros without scanning when the vector store is unavailable", async () => {
    // A never-initialized VectorStore reports unavailable
    const uninitialized = new VectorStore(store.getRawDb(), embeddings);
    store.insertObservation(makeObservation());

    const result = await backfillVectors(store, uninitialized, undefined, {
      delayMs: 0,
    });

    expect(result).toEqual({ scanned: 0, indexed: 0 });
  });

  it("continues past per-observation indexing failures", async () => {
    const a = store.insertObservation(makeObservation({ title: "first" }));
    const b = store.insertObservation(makeObservation({ title: "second" }));
    const c = store.insertObservation(makeObservation({ title: "third" }));

    // Stub store that fails for the middle observation only
    const failingVectorStore = {
      isAvailable: () => true,
      indexObservation: async (id: number) => {
        if (id === b.id) throw new Error("embedding blew up");
        return 2;
      },
    } as unknown as VectorStore;

    const logs: string[] = [];
    const result = await backfillVectors(
      store,
      failingVectorStore,
      (m) => logs.push(m),
      { delayMs: 0 },
    );

    expect(result.scanned).toBe(3);
    expect(result.indexed).toBe(2); // a and c — b's failure must not abort
    expect(logs.join("\n")).toContain("1 failed");
    void a;
    void c;
  });
});
