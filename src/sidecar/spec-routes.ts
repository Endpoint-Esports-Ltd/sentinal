/**
 * Spec Sidecar Routes
 *
 * Serves the spec-timing data that `spec_metrics` needs in sidecar mode
 * (H2): the tool previously required a direct `SpecStore`, which is always
 * null in production, so every call reported "No spec found.".
 *
 * One route, one shape — exactly the two store reads the tool performs
 * (`getSpecTiming` + `getTaskTiming`), not a general query surface.
 * Separated from routes.ts (461 lines, over the 400-line warn) following
 * the per-domain precedent of quality-routes.ts / tdd-routes.ts.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail } from "./response.js";

// ─── Response Shape ──────────────────────────────────────────────────────────

/** Spec-level timing row (mirrors SpecStore.getSpecTiming). */
export interface SpecTimingData {
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}

/** Task-level timing row (mirrors SpecStore.getTaskTiming). */
export interface TaskTimingData {
  position: number;
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * Everything `spec_metrics` reads from the store for one spec.
 * `spec` is null when the spec id is unknown; `tasks` is then empty.
 */
export interface SpecMetricsData {
  spec: SpecTimingData | null;
  tasks: TaskTimingData[];
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * Handle GET /spec/metrics?spec_id=... requests.
 * Returns null for non-matching paths so the dispatcher falls through.
 */
export async function handleSpecMetricsRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/spec/metrics" || req.method !== "GET") return null;

  const specId = url.searchParams.get("spec_id");
  if (!specId) return fail("Missing spec_id parameter");

  try {
    const spec = ctx.specStore.getSpecTiming(specId);
    const tasks = spec ? ctx.specStore.getTaskTiming(specId) : [];
    const data: SpecMetricsData = { spec, tasks };
    return ok(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(msg, 500);
  }
}
