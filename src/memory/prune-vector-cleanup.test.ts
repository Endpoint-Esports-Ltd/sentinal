/**
 * Prune → vector cleanup tests (M6a of
 * docs/plans/2026-09-02-audit-medium-remediation.md).
 *
 * Three prune paths bypass vector cleanup today, leaving orphaned rows in
 * `observation_vectors` that permanently consume KNN k-slots:
 *   1. `MemoryStore.prune` (age-based)
 *   2. `memory_maintain`'s prune action (quality-based raw DELETE)
 *   3. CLI `MemoryService.prune` (delegates to store.prune)
 *
 * These tests require sqlite-vec (Homebrew SQLite on macOS) and skip
 * gracefully when unavailable, same as vector-store.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { VectorStore, loadCustomSqlite } from "./vector-store.js";
import { EmbeddingService } from "./embeddings.js";
import { registerMemoryTools } from "./mcp-tools.js";
import { captureTools } from "../test-helpers.js";
import type { CreateObservation } from "./types.js";

loadCustomSqlite();

const DIMS = 384;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-prune-vec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeObservation(
  overrides: Partial<CreateObservation> = {},
): CreateObservation {
  return {
    sessionId: "s",
    projectPath: "/test/project",
    timestamp: Date.now(),
    type: "discovery",
    title: "Test observation",
    content: "Some test content",
    filePaths: [],
    tags: [],
    metadata: {},
    ...overrides,
  };
}

/** Insert a fake vector row for an observation (no embedding model needed). */
function insertVectorRow(store: MemoryStore, observationId: number): void {
  store
    .getRawDb()
    .prepare(
      `INSERT INTO observation_vectors(rowid, embedding, observation_id, field_type, project, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      observationId * 1000,
      EmbeddingService.toBlob(new Float32Array(DIMS)),
      observationId,
      "title",
      "/test/project",
      Date.now(),
    );
}

function vectorRowsFor(store: MemoryStore, observationId: number): number {
  const row = store
    .getRawDb()
    .prepare(
      "SELECT COUNT(*) as count FROM observation_vectors WHERE rowid >= ? AND rowid < ?",
    )
    .get(observationId * 1000, observationId * 1000 + 1000) as {
    count: number;
  };
  return row.count;
}

describe("prune paths clean up vector rows (M6a)", () => {
  let dir: string;
  let store: MemoryStore;
  let service: MemoryService;
  let vectorAvailable: boolean;

  beforeEach(async () => {
    dir = makeTmpDir();
    store = new MemoryStore(join(dir, "test.db"));
    service = new MemoryService(store);
    // Initialize the vec0 table on the store's own connection, exactly like
    // the sidecar does (VectorStore wraps store.getRawDb()).
    const vectorStore = new VectorStore(
      store.getRawDb(),
      new EmbeddingService(),
    );
    await vectorStore.initialize();
    vectorAvailable = vectorStore.isAvailable();
    if (!vectorAvailable) {
      console.warn(
        "sqlite-vec unavailable — skipping prune vector-cleanup tests:",
        vectorStore.getInitError(),
      );
    }
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("store.prune removes vector rows for pruned observations only", () => {
    if (!vectorAvailable) return;

    const old = service.addObservation(
      makeObservation({
        title: "old",
        timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000,
      }),
    );
    const fresh = service.addObservation(makeObservation({ title: "fresh" }));
    insertVectorRow(store, old.id);
    insertVectorRow(store, fresh.id);

    const pruned = store.prune(90 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);

    // Pruned observation's vector rows are gone; survivor's remain.
    expect(vectorRowsFor(store, old.id)).toBe(0);
    expect(vectorRowsFor(store, fresh.id)).toBe(1);
  });

  it("service.prune (the CLI path) removes vector rows for pruned observations", () => {
    if (!vectorAvailable) return;

    const old = service.addObservation(
      makeObservation({
        title: "cli-old",
        timestamp: Date.now() - 400 * 24 * 60 * 60 * 1000,
      }),
    );
    insertVectorRow(store, old.id);

    const pruned = service.prune(90 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(vectorRowsFor(store, old.id)).toBe(0);
  });

  it("memory_maintain prune removes vector rows for pruned observations only", async () => {
    if (!vectorAvailable) return;

    const doomed = service.addObservation(makeObservation({ title: "doomed" }));
    const kept = service.addObservation(makeObservation({ title: "kept" }));
    // Force one below the quality threshold.
    store
      .getRawDb()
      .prepare("UPDATE observations SET quality_score = 0.01 WHERE id = ?")
      .run(doomed.id);
    insertVectorRow(store, doomed.id);
    insertVectorRow(store, kept.id);

    const tools = captureTools(registerMemoryTools, { store });
    const result = await tools.get("memory_maintain")!({ action: "prune" });
    expect(result.content[0].text).toContain("Pruned 1");

    expect(store.getObservation(doomed.id)).toBeNull();
    expect(vectorRowsFor(store, doomed.id)).toBe(0);
    expect(vectorRowsFor(store, kept.id)).toBe(1);
  });

  it("prune still works when the vector table does not exist (FTS-only DB)", () => {
    // A store whose DB never had the vector stack initialized.
    const bareDir = makeTmpDir();
    const bareStore = new MemoryStore(join(bareDir, "bare.db"));
    try {
      const bareService = new MemoryService(bareStore);
      bareService.addObservation(
        makeObservation({
          title: "old-bare",
          timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000,
        }),
      );
      expect(bareStore.prune(90 * 24 * 60 * 60 * 1000)).toBe(1);
    } finally {
      bareStore.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
