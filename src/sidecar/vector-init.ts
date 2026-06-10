/**
 * Background Vector Search Initialization
 *
 * Initializes the semantic search stack (sqlite-vec + embeddings +
 * orchestrator) AFTER the sidecar is listening and late-injects it into the
 * live MemoryService. Split out of server.ts to keep that file under the
 * repo's 400-line warn threshold.
 *
 * Degrades loudly: missing native deps are logged with the setup hint and
 * surfaced via a one-time dashboard notification.
 */

import { EmbeddingService } from "../memory/embeddings.js";
import { VectorStore } from "../memory/vector-store.js";
import { SearchOrchestrator } from "../memory/search/orchestrator.js";
import {
  nativeDepsStatus,
  type NativeDepsStatus,
} from "../memory/native-deps.js";
import { backfillVectors } from "../memory/backfill.js";
import { logSidecar } from "../utils/file-log.js";
import { notifyVectorUnavailableOnce } from "./vector-stats.js";
import type { MemoryStore } from "../memory/store.js";
import type { SidecarContext, SidecarServerOptions } from "./server.js";

/**
 * Runtime state of the background vector search initialization.
 * Set by `initVectorSearch()`; consumed by stats/backfill.
 */
export interface VectorSearchState {
  status: "disabled" | "initializing" | "ready" | "unavailable";
  vectorStore?: VectorStore;
  orchestrator?: SearchOrchestrator;
  /** Degrade reason when status is "unavailable". */
  error?: string;
}

/** Injectable factories for testing initVectorSearch without native deps. */
export interface InitVectorSearchDeps {
  createEmbeddings?: () => EmbeddingService;
  createVectorStore?: (
    db: ReturnType<MemoryStore["getRawDb"]>,
    embeddings: EmbeddingService,
  ) => VectorStore;
  createOrchestrator?: (
    store: MemoryStore,
    vectorStore: VectorStore,
  ) => SearchOrchestrator;
  depsStatus?: () => Promise<NativeDepsStatus>;
}

/** True when vector search should initialize for these options/env. */
export function vectorSearchEnabled(opts: SidecarServerOptions): boolean {
  if (opts.enableVectorSearch === false) return false;
  if (process.env.SENTINAL_DISABLE_VECTOR_SEARCH === "1") return false;
  return true;
}

/**
 * Initialize the semantic search stack and late-inject it into the live
 * MemoryService. Runs in the background AFTER the server is listening —
 * never on the startup path. Mutates `ctx.service` (routes capture the
 * service reference, so the instance is never replaced).
 *
 * Degrades loudly: missing native deps are logged with the setup hint.
 */
export async function initVectorSearch(
  ctx: SidecarContext,
  deps: InitVectorSearchDeps = {},
): Promise<void> {
  ctx.vectorState = { status: "initializing" };
  try {
    const embeddings = deps.createEmbeddings?.() ?? new EmbeddingService();
    const vectorStore =
      deps.createVectorStore?.(ctx.store.getRawDb(), embeddings) ??
      new VectorStore(ctx.store.getRawDb(), embeddings);

    // sqlite-vec first (cheap) — fail fast before the model load
    await vectorStore.initialize();
    if (!vectorStore.isAvailable()) {
      const reason =
        vectorStore.getInitError() ?? "unknown vector store init error";
      await markVectorUnavailable(ctx, vectorStore, reason, deps);
      return;
    }

    // Warm the embedding model — auto-indexing and vector queries both
    // gate on embeddings.isAvailable(), so it must be initialized here.
    await embeddings.initialize();
    if (!embeddings.isAvailable()) {
      const reason =
        embeddings.getInitError() ?? "unknown embedding init error";
      await markVectorUnavailable(ctx, vectorStore, reason, deps);
      return;
    }

    // Orchestrator checks isAvailable() in its constructor — build it
    // only after vectorStore.initialize() succeeded.
    const orchestrator =
      deps.createOrchestrator?.(ctx.store, vectorStore) ??
      new SearchOrchestrator(ctx.store, vectorStore);

    ctx.service.setSearchBackends(vectorStore, orchestrator);
    ctx.vectorState = { status: "ready", vectorStore, orchestrator };
    logSidecar(
      `sidecar: vector search ready (${vectorStore.getVectorCount()} vectors)`,
    );

    // Fire-and-forget: index observations saved while vectors were offline.
    // Paced one observation at a time so hook responses stay <100ms.
    void backfillVectors(ctx.store, vectorStore, logSidecar).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logSidecar(`sidecar: vector backfill failed — ${message}`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.vectorState = { status: "unavailable", error: message };
    logSidecar(`sidecar: vector search init failed — ${message}`);
  }
}

/** Record + loudly log a degraded vector search state with the setup hint. */
async function markVectorUnavailable(
  ctx: SidecarContext,
  vectorStore: VectorStore,
  reason: string,
  deps: InitVectorSearchDeps,
): Promise<void> {
  ctx.vectorState = { status: "unavailable", vectorStore, error: reason };
  let hint: string | null = null;
  try {
    const status = await (deps.depsStatus ?? nativeDepsStatus)();
    hint = status.hint;
  } catch {
    /* hint is best-effort */
  }
  logSidecar(
    // Avoid duplicating the hint when the reason already contains it
    `sidecar: vector search unavailable — ${reason}${hint && !reason.includes(hint) ? ` — ${hint}` : ""}`,
  );
  // One-time dashboard notification (version-scoped settings-key guard makes
  // this idempotent with the lazy stats-route path).
  try {
    notifyVectorUnavailableOnce(ctx.store, reason);
  } catch {
    /* notification is best-effort */
  }
}

/** Fire-and-forget background vector init. Never blocks the listen path. */
export function startBackgroundVectorInit(
  ctx: SidecarContext,
  enabled: boolean,
): void {
  if (!enabled) {
    ctx.vectorState = { status: "disabled" };
    return;
  }
  void initVectorSearch(ctx);
}
