/**
 * Sidecar API Routes — the core dispatcher.
 *
 * All endpoints return JSON: { ok: true, data: ... } or { ok: false, error: "..." }
 * Used by hooks, MCP server, and OpenCode plugin via SidecarClient.
 *
 * Handlers live in per-domain modules; each sub-handler returns
 * `Response | null` (null = not mine) and runs inside this function's
 * try/catch, so any error becomes a 500 JSON response:
 * - session-routes.ts       /session*
 * - tdd-routes.ts           /tdd-state (GET/POST), /tdd-state/list
 * - memory-routes.ts        /observation, /context, /memory/*
 * - spec-routes.ts          /spec/sync, /spec/current, /spec/events
 * - notification-routes.ts  POST /notification
 * Project keys are normalized by project-key.ts.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail } from "./response.js";
import { getSentinalVersion } from "./version.js";
import { handleSessionRoute } from "./session-routes.js";
import { handleTddStateRoute } from "./tdd-routes.js";
import { handleMemoryRoute } from "./memory-routes.js";
import { handleSpecRoute } from "./spec-routes.js";
import { handleInsertNotificationRoute } from "./notification-routes.js";

// ─── Router ──────────────────────────────────────────────────────────────

export async function handleSidecarRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health
    if (path === "/health" && method === "GET") {
      return ok({
        status: "running",
        pid: process.pid,
        httpPort: ctx.httpPort ?? null,
        version: getSentinalVersion(),
      });
    }

    // Ping — lightweight keep-alive for idle shutdown
    if (path === "/ping" && method === "GET") {
      return ok({ pong: true });
    }

    // Built per request (not a module-level array) so the live imported
    // bindings are read on every call and `spyOn(module, …)` still intercepts.
    const subHandlers = [
      handleSessionRoute,
      handleTddStateRoute,
      handleMemoryRoute,
      handleSpecRoute,
      handleInsertNotificationRoute,
    ];
    for (const handle of subHandlers) {
      const response = await handle(url, req, ctx);
      if (response) return response;
    }

    return fail("Not found", 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`Internal error: ${message}`, 500);
  }
}
