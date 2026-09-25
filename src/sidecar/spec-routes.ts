/**
 * Spec Sidecar Routes
 *
 * Serves the spec-timing data that `spec_metrics` needs in sidecar mode
 * (H2): the tool previously required a direct `SpecStore`, which is always
 * null in production, so every call reported "No spec found.".
 *
 * `/spec/metrics`: one route, one shape — exactly the two store reads the
 * tool performs (`getSpecTiming` + `getTaskTiming`), not a general query
 * surface. Dispatched directly by the server's fetch handler.
 *
 * Also hosts `/spec/sync`, `/spec/current` and `/spec/events`, moved out of
 * routes.ts to keep it under the 400-line limit (see `handleSpecRoute`).
 */

import type { SidecarContext } from "./server.js";
import { ok, fail, readBody } from "./response.js";
import {
  MISSING_PROJECT_PATH,
  normalizeProjectFilter,
  normalizeProjectKey,
} from "./project-key.js";

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
  // D6: an optional project disambiguates a slug several projects share.
  const project = normalizeProjectFilter(url.searchParams.get("project"));

  try {
    const spec = ctx.specStore.getSpecTiming(specId, project);
    const tasks = spec ? ctx.specStore.getTaskTiming(specId, project) : [];
    const data: SpecMetricsData = { spec, tasks };
    return ok(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(msg, 500);
  }
}

// ─── Spec sync / current / events ────────────────────────────────────────────

/**
 * Handle `POST /spec/sync`, `GET /spec/current` and `GET /spec/events`.
 * Dispatched from `handleSidecarRequest` (routes.ts) inside its try/catch.
 * Returns null for any other request.
 */
export async function handleSpecRoute(
  url: URL,
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/spec/sync" && method === "POST") {
    return handleSyncSpec(req, ctx);
  }
  if (path === "/spec/current" && method === "GET") {
    return handleGetCurrentSpec(url, ctx);
  }
  if (path === "/spec/events" && method === "GET") {
    return handleGetSpecEvents(url, ctx);
  }
  return null;
}

async function handleSyncSpec(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    planPath: string;
    projectPath?: unknown;
    sessionId?: string | null;
  }>(req);
  // D3 — a write: blank/absent is a 400, never an empty or sidecar-cwd key.
  const projectPath = normalizeProjectKey(body.projectPath);
  if (!projectPath) return fail(MISSING_PROJECT_PATH);
  ctx.specStore.syncFromPlanFile(
    body.planPath,
    projectPath,
    body.sessionId ?? undefined,
  );
  return ok();
}

function handleGetCurrentSpec(url: URL, ctx: SidecarContext): Response {
  // A read, but "current spec of ALL projects" is meaningless — still required.
  const projectPath = normalizeProjectFilter(url.searchParams.get("project"));
  if (!projectPath) return fail("Missing 'project' query param");

  const spec = ctx.specStore.getCurrentSpec(projectPath);
  return ok(spec);
}

function handleGetSpecEvents(url: URL, ctx: SidecarContext): Response {
  const specId = url.searchParams.get("spec_id");
  if (!specId) return fail("Missing 'spec_id' query param");
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const events = ctx.store.getSpecEvents(specId, limit);
  return ok(events);
}
