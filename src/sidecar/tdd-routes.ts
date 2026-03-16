/**
 * TDD Sidecar Routes
 *
 * Handles bulk TDD state transitions used by the OpenCode plugin.
 * Separated from routes.ts to stay under the 400-line limit.
 */

import type { MemoryStore } from "../memory/store.js";
import type { SidecarContext } from "./server.js";

// ─── Bulk Transition Logic ────────────────────────────────────────────────────

export interface TransitionResult {
  count: number;
}

/**
 * Perform bulk TDD state transitions.
 *
 * - `confirm_red`: Transition all TEST_WRITTEN → RED_CONFIRMED
 * - `confirm_green`: Clear (delete) all RED_CONFIRMED states
 *
 * Optionally scoped to a specific spec ID.
 */
export function bulkTddTransition(
  store: MemoryStore,
  action: "confirm_red" | "confirm_green",
  specId?: string,
): TransitionResult {
  const db = store.getRawDb();

  if (action === "confirm_red") {
    const specClause = specId ? " AND spec_id = ?" : "";
    const params = specId ? [Date.now(), specId] : [Date.now()];
    const result = db
      .prepare(
        `UPDATE tdd_cycles SET state = 'RED_CONFIRMED', updated_at = ? WHERE state = 'TEST_WRITTEN'${specClause}`,
      )
      .run(...params);
    return { count: result.changes };
  }

  // confirm_green: clear RED_CONFIRMED states
  const specClause = specId ? " AND spec_id = ?" : "";
  const params = specId ? [specId] : [];
  const result = db
    .prepare(
      `DELETE FROM tdd_cycles WHERE state = 'RED_CONFIRMED'${specClause}`,
    )
    .run(...params);
  return { count: result.changes };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * Handle /tdd-state/transition requests. Returns null for non-matching paths.
 */
export async function handleTddTransitionRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/tdd-state/transition" || req.method !== "POST")
    return null;

  try {
    const body = (await req.json()) as { action?: string; specId?: string };
    const { action, specId } = body;

    if (action !== "confirm_red" && action !== "confirm_green") {
      return Response.json(
        {
          ok: false,
          error: "Invalid action. Must be 'confirm_red' or 'confirm_green'.",
        },
        { status: 400 },
      );
    }

    const result = bulkTddTransition(ctx.store, action, specId);
    return Response.json({ ok: true, data: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
