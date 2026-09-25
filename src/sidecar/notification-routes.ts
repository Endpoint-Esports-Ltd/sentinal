/**
 * Notification Routes — the READ side of notifications, for clients that
 * cannot open the store themselves (the OpenCode plugin: no bun:sqlite in its
 * bundle).
 *
 *   GET  /notifications/session?project=<path>&limit=<n>
 *        Unread candidates for session start. Side-effect free.
 *   POST /notifications/read   { id }
 *        Mark exactly ONE notification read.
 *
 * Eligibility is delegated to `listSessionNotificationCandidates`, the same
 * query the Claude Code SessionStart hook uses, so the targets cannot drift.
 * ⛔ There is deliberately no "mark all read" route: the store's
 * markAllNotificationsRead() is GLOBAL and would clear other projects'
 * notifications and the dashboard badge.
 *
 * Also hosts the WRITE side, `POST /notification` (`handleInsertNotificationRoute`),
 * moved out of routes.ts and dispatched from `handleSidecarRequest` inside its
 * try/catch. Its optional `projectPath` (D5) is what lets a warning reach
 * its own project's session digest; absent means NULL, as before.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail, readBody } from "./response.js";
import { normalizeProjectKey, MISSING_PROJECT_PATH } from "./project-key.js";
import { listSessionNotificationCandidates } from "../hooks/session-notifications.js";
import type { NotificationType } from "../memory/types.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const MISSING_PROJECT =
  "Missing or empty 'project' — the sidecar cannot infer it from its own cwd";

function limitFrom(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function readId(req: Request): Promise<number | null> {
  try {
    const body = (await req.json()) as { id?: unknown } | null;
    const id = body?.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Handle the notification read routes. Returns null for any other request. */
export async function handleNotificationRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/notifications/session" && req.method === "GET") {
    const project = normalizeProjectKey(url.searchParams.get("project"));
    if (!project) return fail(MISSING_PROJECT);
    return ok(
      listSessionNotificationCandidates(
        ctx.store,
        project,
        limitFrom(url.searchParams.get("limit")),
      ),
    );
  }

  if (url.pathname === "/notifications/read" && req.method === "POST") {
    const id = await readId(req);
    if (id === null) return fail("'id' must be a positive integer");
    ctx.store.markNotificationRead(id);
    return ok();
  }

  return null;
}

/**
 * Handle `POST /notification` (insert). Dispatched from `handleSidecarRequest`
 * (routes.ts) inside its try/catch. Returns null for any other request.
 */
export async function handleInsertNotificationRoute(
  url: URL,
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  if (url.pathname !== "/notification" || req.method !== "POST") return null;

  const body = await readBody<{
    type: string;
    title: string;
    message?: string;
    source?: string;
    specId?: string;
    sessionId?: string;
    projectPath?: string;
  }>(req);

  // D5: absent → NULL (old clients send none); present → canonical identity,
  // and a blank one is refused rather than stored as "" or treated as global.
  let projectPath: string | null = null;
  if (body.projectPath !== undefined && body.projectPath !== null) {
    projectPath = normalizeProjectKey(body.projectPath);
    if (!projectPath) return fail(MISSING_PROJECT_PATH);
  }

  const notif = ctx.store.insertNotification({
    type: body.type as NotificationType,
    title: body.title,
    message: body.message ?? null,
    source: body.source ?? null,
    specId: body.specId ?? null,
    sessionId: body.sessionId ?? null,
    projectPath,
  });
  return ok(notif);
}
