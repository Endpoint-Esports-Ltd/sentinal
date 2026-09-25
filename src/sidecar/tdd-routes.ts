/**
 * TDD Sidecar Routes
 *
 * - `/tdd-state/transition` — bulk transitions used by the OpenCode plugin,
 *   dispatched directly by the server's fetch handler.
 * - `/tdd-state` GET/POST and `/tdd-state/list` — per-file get/set/clear and
 *   the active list, dispatched from `handleSidecarRequest` (routes.ts)
 *   inside its try/catch.
 */

import type { MemoryStore } from "../memory/store.js";
import type { TddCycleState } from "../memory/types.js";
import type { SidecarContext } from "./server.js";
import { logSidecar } from "../utils/file-log.js";
import { ok, fail, readBody } from "./response.js";
import {
  MISSING_PROJECT_PATH,
  inferProjectFromFile,
  normalizeProjectFilter,
  normalizeProjectKey,
} from "./project-key.js";

// ─── Bulk Transition Logic ────────────────────────────────────────────────────

export interface TransitionResult {
  count: number;
}

export interface TransitionScope {
  /** REQUIRED. Canonical project key (`tdd_cycles.project_path`). */
  projectPath: string;
  /** Optional further narrowing to one spec. */
  specId?: string;
}

/**
 * Perform bulk TDD state transitions, scoped to ONE project.
 *
 * - `confirm_red`: Transition the project's TEST_WRITTEN → RED_CONFIRMED
 * - `confirm_green`: Clear (delete) the project's RED_CONFIRMED states
 *
 * ⛔ D6 — destructive writes fail CLOSED. `tdd_cycles.file_path` is globally
 * unique with no project qualifier, so an unscoped sweep here used to delete
 * every OTHER project's RED state on the machine. A blank project throws
 * rather than degrading to "all". Rows with a NULL `project_path` are never
 * touched by a bulk transition. (Reads — `listActiveTddStates` — deliberately
 * fail OPEN instead; do not harmonise the two.)
 */
export function bulkTddTransition(
  store: MemoryStore,
  action: "confirm_red" | "confirm_green",
  scope: TransitionScope,
): TransitionResult {
  const { projectPath, specId } = scope;
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    throw new Error(
      "bulkTddTransition requires a projectPath — refusing an unscoped sweep",
    );
  }
  const db = store.getRawDb();
  const specClause = specId ? " AND spec_id = ?" : "";
  const scopeParams = specId ? [projectPath, specId] : [projectPath];

  if (action === "confirm_red") {
    const result = db
      .prepare(
        `UPDATE tdd_cycles SET state = 'RED_CONFIRMED', updated_at = ? WHERE state = 'TEST_WRITTEN' AND project_path = ?${specClause}`,
      )
      .run(Date.now(), ...scopeParams);
    return { count: result.changes };
  }

  // confirm_green: clear RED_CONFIRMED states
  const result = db
    .prepare(
      `DELETE FROM tdd_cycles WHERE state = 'RED_CONFIRMED' AND project_path = ?${specClause}`,
    )
    .run(...scopeParams);
  return { count: result.changes };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * Distinct `sidecar.log` marker for a transition rejected for lack of a
 * project. The only caller (the OpenCode plugin) swallows errors in two
 * `catch {}` layers, so this log line is the ONLY signal a plumbing miss
 * leaves behind. Grep `sentinal sidecar logs` for it.
 */
export const MISSING_TRANSITION_PROJECT_LOG =
  "tdd-transition REJECTED: missing projectPath";

/**
 * Handle /tdd-state/transition requests. Returns null for non-matching paths.
 *
 * Body: `{ action: "confirm_red" | "confirm_green", projectPath: string, specId?: string }`.
 * A missing/blank `projectPath` is a 400 — never an unscoped sweep (D6).
 */
export async function handleTddTransitionRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/tdd-state/transition" || req.method !== "POST")
    return null;

  try {
    const body = (await req.json()) as {
      action?: string;
      specId?: string;
      projectPath?: unknown;
    };
    const { action, specId } = body;

    if (action !== "confirm_red" && action !== "confirm_green") {
      return fail("Invalid action. Must be 'confirm_red' or 'confirm_green'.");
    }

    const projectPath = normalizeProjectKey(body.projectPath);
    if (!projectPath) {
      logSidecar(
        `${MISSING_TRANSITION_PROJECT_LOG} (action=${action}, specId=${specId ?? "none"}) — ` +
          "refusing an unscoped sweep across every project; the caller must send projectPath",
      );
      return fail(
        "Missing or empty 'projectPath' — a bulk TDD transition must be scoped " +
          "to one project and will not sweep every project",
      );
    }

    const result = bulkTddTransition(ctx.store, action, {
      projectPath,
      specId,
    });
    return ok(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(msg, 500);
  }
}

// ─── Per-file state: get / set / clear / list ────────────────────────────────

/**
 * Handle `GET|POST /tdd-state` and `GET /tdd-state/list`. Returns null for any
 * other request (including `/tdd-state/transition`, served above).
 */
export async function handleTddStateRoute(
  url: URL,
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/tdd-state" && method === "GET") {
    return handleGetTddState(url, ctx);
  }
  if (path === "/tdd-state" && method === "POST") {
    return handleSetTddState(req, ctx);
  }
  if (path === "/tdd-state/list" && method === "GET") {
    return handleListTddStates(url, ctx);
  }
  return null;
}

function handleGetTddState(url: URL, ctx: SidecarContext): Response {
  const filePath = url.searchParams.get("file");
  const projectPath = normalizeProjectFilter(url.searchParams.get("project"));
  if (!filePath) return fail("Missing 'file' query param");

  const tddState = ctx.store.getTddState(filePath);
  let hasActiveSpec = false;
  if (projectPath) {
    const spec = ctx.specStore.getCurrentSpec(projectPath);
    hasActiveSpec = spec !== null;
  }

  return ok({ state: tddState?.state ?? "IDLE", hasActiveSpec });
}

async function handleSetTddState(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    action: "set" | "clear" | "clearForSpec";
    filePath?: string;
    specId?: string;
    state?: TddCycleState;
    taskPosition?: number;
    testFilePath?: string;
    lastFailOutput?: string;
    projectPath?: string;
  }>(req);

  // Project on a `set`: present → normalized (blank/garbage is a 400, never an
  // unscoped row). ABSENT → inferred (D4) from the file itself — the nearest
  // existing ancestor of `dirname(filePath)` — because older callers (≤1.37.1
  // plugin, `tdd_set_state`) send none. A relative filePath cannot be
  // inferred without the sidecar's meaningless cwd: 400. COALESCE still keeps
  // an already-scoped row's key if the inferred one were ever null.
  const hasProject = body.projectPath !== undefined;
  let projectPath = hasProject ? normalizeProjectKey(body.projectPath) : null;
  if (body.action === "set" && hasProject && !projectPath) {
    return fail(MISSING_PROJECT_PATH);
  }
  if (body.action === "set" && !hasProject) {
    projectPath = inferProjectFromFile(body.filePath);
    if (!projectPath) {
      return fail(
        "Missing 'projectPath' and 'filePath' is not absolute — cannot infer " +
          "the project",
      );
    }
    logSidecar(
      `tdd-state: set without projectPath — inferred projectPath ${projectPath} for ${body.filePath}`,
    );
  }

  if (body.action === "clear" && body.filePath) {
    ctx.store.clearTddState(body.filePath);
  } else if (body.action === "clearForSpec" && body.specId) {
    ctx.store.clearTddStatesForSpec(body.specId);
  } else if (body.action === "set" && body.filePath && body.state) {
    try {
      ctx.store.setTddState({
        filePath: body.filePath,
        state: body.state,
        specId: body.specId,
        taskPosition: body.taskPosition,
        testFilePath: body.testFilePath,
        lastFailOutput: body.lastFailOutput,
        projectPath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("FOREIGN KEY")) {
        return fail(
          "FOREIGN KEY constraint failed: spec_id does not exist",
          400,
        );
      }
      throw e;
    }
  } else {
    return fail("Invalid action or missing required fields");
  }
  return ok();
}

function handleListTddStates(url: URL, ctx: SidecarContext): Response {
  const specId = url.searchParams.get("spec_id") || undefined;
  // D3 — reads fail open: absent/blank = every project; supplied = canonical.
  const project = normalizeProjectFilter(url.searchParams.get("project"));
  const states = ctx.store.listActiveTddStates(specId ?? null, project);
  return ok(states);
}
