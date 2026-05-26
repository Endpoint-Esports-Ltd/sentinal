/**
 * Worktree Sidecar Routes
 *
 * Handles all /worktree/* routes. Separated from routes.ts to keep it
 * under the 400-line limit and to co-locate worktree route logic.
 *
 * Routes:
 *   GET  /worktree/resolve  — resolve worktree by plan slug
 *   POST /worktree/abandon  — abandon a worktree by ID
 *   POST /worktree/cleanup  — clean up stale worktrees
 */

import type { SidecarContext } from "./server.js";
import { WorktreeManager } from "../worktree/manager.js";
import { DEFAULT_WORKTREE_CONFIG } from "../worktree/types.js";
import { ok, fail } from "./response.js";

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * Handle all /worktree/* requests. Returns null for non-matching paths.
 */
export async function handleWorktreeRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const method = req.method;

  if (!pathname.startsWith("/worktree/")) return null;

  try {
    if (pathname === "/worktree/resolve" && method === "GET") {
      return handleResolveWorktree(url, ctx);
    }
    if (pathname === "/worktree/abandon" && method === "POST") {
      return await handleAbandonWorktree(req, ctx);
    }
    if (pathname === "/worktree/cleanup" && method === "POST") {
      return await handleCleanupWorktrees(req, ctx);
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(msg, 500);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleResolveWorktree(url: URL, ctx: SidecarContext): Response {
  const slug = url.searchParams.get("slug");
  if (!slug) return fail("Missing 'slug' query param");
  const project = url.searchParams.get("project") ?? undefined;
  const wt = ctx.wtStore.resolveBySlug(slug, project);
  return ok(wt);
}

async function handleAbandonWorktree(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = (await req.json()) as { worktree_id?: string };
  const { worktree_id } = body;

  if (!worktree_id) return fail("Missing 'worktree_id' in request body");

  const wt = ctx.wtStore.get(worktree_id);
  if (!wt) return fail(`Worktree ${worktree_id} not found`, 404);

  const manager = new WorktreeManager(ctx.wtStore, DEFAULT_WORKTREE_CONFIG);
  manager.abandon(worktree_id);

  return ok({ worktree_id, status: "abandoned" });
}

async function handleCleanupWorktrees(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const manager = new WorktreeManager(ctx.wtStore, DEFAULT_WORKTREE_CONFIG);
  const cleaned = manager.cleanup();
  return ok({ cleaned });
}
