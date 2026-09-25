/**
 * Session Sidecar Routes
 *
 *   POST /session              create (idempotent on id)
 *   POST /session/:id/end      end, optionally emitting a notification
 *   GET  /session/active       active sessions
 *   POST /session/touch        heartbeat
 *   GET  /session/alive?id=    liveness
 *
 * Dispatched from `handleSidecarRequest` (routes.ts) inside its try/catch.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail, readBody } from "./response.js";
import { MISSING_PROJECT_PATH, normalizeProjectKey } from "./project-key.js";
import type { AssistantType, NotificationType } from "../memory/types.js";

/** Handle the /session routes. Returns null for any other request. */
export async function handleSessionRoute(
  url: URL,
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/session" && method === "POST") {
    return handleCreateSession(req, ctx);
  }
  if (
    path.startsWith("/session/") &&
    path.endsWith("/end") &&
    method === "POST"
  ) {
    const id = path.slice("/session/".length, -"/end".length);
    return handleEndSession(id, req, ctx);
  }
  if (path === "/session/active" && method === "GET") {
    return ok(ctx.store.getActiveSessions());
  }
  if (path === "/session/touch" && method === "POST") {
    return handleTouchSession(req, ctx);
  }
  if (path === "/session/alive" && method === "GET") {
    const id = url.searchParams.get("id");
    return ok({ alive: id ? ctx.store.isSessionAlive(id) : false });
  }
  return null;
}

async function handleCreateSession(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    id: string;
    projectPath: string;
    assistant: string;
    transcriptPath?: string | null;
  }>(req);

  const projectPath = normalizeProjectKey(body.projectPath);
  if (!projectPath) return fail(MISSING_PROJECT_PATH);

  try {
    const session = ctx.store.insertSession({
      id: body.id,
      startTime: Date.now(),
      endTime: null,
      projectPath,
      assistant: body.assistant as AssistantType,
      summary: null,
      transcriptPath: body.transcriptPath ?? null,
    });
    return ok(session);
  } catch (e) {
    // UNIQUE constraint — session already exists, return it from the store
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("UNIQUE constraint")) {
      const existing = ctx.store
        .getActiveSessions()
        .find((s) => s.id === body.id);
      if (existing) return ok(existing);
    }
    throw e;
  }
}

async function handleEndSession(
  id: string,
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{ summary?: string; notification?: boolean }>(
    req,
  );
  ctx.store.endSession(id, body.summary);

  if (body.notification !== false) {
    ctx.store.insertNotification({
      type: "info" as NotificationType,
      title: "Session ended",
      message: `Session ${id.slice(0, 8)} ended`,
      source: "session-end",
      sessionId: id,
    });
  }
  return ok();
}

async function handleTouchSession(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{ sessionId: string }>(req);
  if (!body.sessionId) return fail("Missing sessionId");
  ctx.store.touchSession(body.sessionId);
  return ok();
}
