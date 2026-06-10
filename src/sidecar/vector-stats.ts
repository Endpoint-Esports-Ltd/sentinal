/**
 * Vector Stats Helpers
 *
 * Maps the sidecar's VectorSearchState into the MemoryStats.vector payload
 * served by /memory/stats, and inserts a one-time "vector search unavailable"
 * notification (guarded by a settings key) so degraded installs are surfaced
 * loudly without spamming on every restart or stats call.
 *
 * Lives outside server.ts on purpose: routes.ts consumes these helpers, and
 * server.ts stays untouched (concurrent backfill work lands there).
 */

import { SETUP_HINT } from "../memory/native-deps.js";
import type { VectorSearchStats } from "../memory/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { VectorSearchState } from "./server.js";

// ─── Version-Scoped Settings Key ─────────────────────────────────────────────

declare const __SENTINAL_VERSION__: string | undefined;

function sentinalVersion(): string {
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }
  return "dev";
}

/**
 * Settings key guarding the one-time notification. Version-scoped so users
 * are re-notified at most once per installed version (source runs use "dev").
 */
export const VECTOR_DEPS_NOTIFIED_KEY = `vector_deps_notified_${sentinalVersion()}`;

// ─── Stats Mapping ───────────────────────────────────────────────────────────

/** Build the MemoryStats.vector payload from the sidecar's vector init state. */
export function buildVectorStats(state: VectorSearchState): VectorSearchStats {
  return {
    status: state.status,
    count:
      state.status === "ready" && state.vectorStore
        ? state.vectorStore.getVectorCount()
        : 0,
    initError: state.error ?? null,
    hint: state.status === "unavailable" ? SETUP_HINT : null,
  };
}

// ─── One-Time Notification ───────────────────────────────────────────────────

/**
 * Insert a "Vector search unavailable" notification at most once per version.
 * Returns true if a notification was inserted, false if already notified.
 */
export function notifyVectorUnavailableOnce(
  store: MemoryStore,
  error?: string,
): boolean {
  if (store.getSetting(VECTOR_DEPS_NOTIFIED_KEY) !== null) {
    return false;
  }
  store.setSetting(VECTOR_DEPS_NOTIFIED_KEY, String(Date.now()));
  store.insertNotification({
    type: "warning",
    title: "Vector search unavailable",
    message: `${error ?? "Native dependencies missing"}. ${SETUP_HINT}`,
    source: "vector-init",
  });
  return true;
}
