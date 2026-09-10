/**
 * OpenCode SDK Session Liveness Probe
 *
 * Builds a `LivenessProbe` for `resolveStopDecision` from the OpenCode SDK
 * `client.session.list()` (verified available on installed OpenCode 1.18.3).
 * A session is "alive" when it appears in the SDK's session list AND its
 * `time.updated` is within the liveness window.
 *
 * Fail-safe: returns `null` when the SDK surface is absent, throws, or returns
 * a malformed payload — the caller then falls back to `MemoryStore.isSessionAlive`.
 * Never fabricates liveness (would risk flipping a stop decision to "allow").
 */

import type { LivenessProbe } from "../spec/ownership.js";

/**
 * Liveness window (ms). Inlined rather than imported from `../memory/types.js`
 * to keep this module out of the memory/SQLite dependency graph — the OpenCode
 * plugin statically imports this file, and pulling in `memory/types` transitively
 * hoists `bun:sqlite` into the embedded plugin bundle (which the self-contained
 * bundle guard forbids). Keep in sync with `SESSION_LIVENESS_WINDOW_MS`.
 */
const SESSION_LIVENESS_WINDOW_MS = 45 * 60 * 1000; // 45 minutes

interface BuildLivenessProbeOptions {
  /** The OpenCode plugin `client` (full SDK client). May lack session.list. */
  client: unknown;
  /** Liveness window in ms (default: SESSION_LIVENESS_WINDOW_MS = 45 min). */
  windowMs?: number;
}

interface SdkSessionLike {
  id?: unknown;
  time?: { updated?: unknown };
}

/**
 * Build a session-liveness probe from the SDK client, or return null to signal
 * "fall back to the store".
 */
export async function buildLivenessProbe(
  opts: BuildLivenessProbeOptions,
): Promise<LivenessProbe | null> {
  const windowMs = opts.windowMs ?? SESSION_LIVENESS_WINDOW_MS;
  const list = getSessionList(opts.client);
  if (!list) return null;

  let sessions: SdkSessionLike[];
  try {
    const res = await list();
    const data = extractArray(res);
    if (!data) return null;
    sessions = data;
  } catch {
    return null; // SDK error → fall back to store
  }

  const cutoff = Date.now() - windowMs;
  const aliveIds = new Set<string>();
  for (const s of sessions) {
    if (typeof s?.id !== "string") continue;
    const updated = s?.time?.updated;
    if (typeof updated === "number" && updated >= cutoff) {
      aliveIds.add(s.id);
    }
  }

  return (sessionId: string): boolean => aliveIds.has(sessionId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Narrow the client to a callable session.list, or null. */
function getSessionList(
  client: unknown,
): (() => Promise<unknown>) | null {
  if (!client || typeof client !== "object") return null;
  const session = (client as { session?: unknown }).session;
  if (!session || typeof session !== "object") return null;
  const list = (session as { list?: unknown }).list;
  return typeof list === "function"
    ? (list as () => Promise<unknown>).bind(session)
    : null;
}

/**
 * Extract the session array from an SDK response. The SDK wraps results as
 * `{ data: Session[] }`; also accept a bare array. Returns null if neither.
 */
function extractArray(res: unknown): SdkSessionLike[] | null {
  if (Array.isArray(res)) return res as SdkSessionLike[];
  if (res && typeof res === "object") {
    const data = (res as { data?: unknown }).data;
    if (Array.isArray(data)) return data as SdkSessionLike[];
  }
  return null;
}
