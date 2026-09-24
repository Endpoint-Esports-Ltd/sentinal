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
 * Lives outside routes.ts, which is at its length budget.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail } from "./response.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { listSessionNotificationCandidates } from "../hooks/session-notifications.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const MISSING_PROJECT =
  "Missing or empty 'project' — the sidecar cannot infer it from its own cwd";

/**
 * Canonical project from a caller-supplied value, or null. Blank is rejected
 * BEFORE resolving: resolveProjectIdentity("") falls back to process.cwd(),
 * which in a detached sidecar is meaningless.
 */
function projectFrom(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return resolveProjectIdentity(raw);
}

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
    const project = projectFrom(url.searchParams.get("project"));
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
