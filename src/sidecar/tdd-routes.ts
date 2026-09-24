/**
 * TDD Sidecar Routes
 *
 * Handles bulk TDD state transitions used by the OpenCode plugin.
 * Separated from routes.ts to stay under the 400-line limit.
 */

import type { MemoryStore } from "../memory/store.js";
import type { SidecarContext } from "./server.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { logSidecar } from "../utils/file-log.js";
import { ok, fail } from "./response.js";

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
 * Normalize a caller-supplied project to the canonical storage key, or `null`.
 * Blank is rejected BEFORE resolving: `resolveProjectIdentity("")` falls back
 * to `process.cwd()`, which in the detached sidecar is meaningless. Mirrors
 * `normalizeProjectKey` in routes.ts (not exported from there).
 */
function normalizeTransitionProject(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const resolved = resolveProjectIdentity(raw);
  return resolved && resolved.trim() !== "" ? resolved : null;
}

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

    const projectPath = normalizeTransitionProject(body.projectPath);
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
