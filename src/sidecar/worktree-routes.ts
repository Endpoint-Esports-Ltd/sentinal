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
import { WorktreeError, type ResolvedWorktree } from "../worktree/types.js";
// ⛔ The sidecar is OUTSIDE src/worktree/, so it may supply the runtime deps
// directly. All three handlers construct through this — abandon needs
// `stopOwnedRuntime` before it removes the directory, cleanup needs
// `ownsLiveRuntime` for guard 5, and resolve needs `sharedResourcesFor` for R11.
import { runtimeWorktreeConfig } from "../runtime/worktree-deps.js";
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
  // Reconcile against the filesystem — on-disk worktrees are authoritative,
  // so a record lost to a transport failure (or wrongly abandoned) is
  // re-registered instead of answering "not found".
  const manager = new WorktreeManager(ctx.wtStore, runtimeWorktreeConfig());
  // ⛔ Collect the warnings. Sidecar mode is the DEFAULT detect path, so
  // dropping them here would leave "warn loudly" (Task 5, Rule 2) enforced only
  // in the fallback direct mode. `warnings` is additive on the serialised
  // Worktree, so consumers reading only `Worktree` fields are unaffected.
  const warnings: string[] = [];
  const wt = manager.resolveWithReconcile(slug, project, warnings);
  if (!wt) return ok(null);

  const resolved: ResolvedWorktree = { ...wt };
  if (warnings.length > 0) resolved.warnings = warnings;
  return ok(resolved);
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

  const manager = new WorktreeManager(ctx.wtStore, runtimeWorktreeConfig());
  // ⛔ `abandon` is async because it stops the owned process group BEFORE it
  // removes the directory. Dropping this await would return "abandoned" while
  // the stop was still in flight, and surface a refusal as an unhandled
  // rejection instead of a response the caller can act on.
  try {
    await manager.abandon(worktree_id);
  } catch (err) {
    // ⛔ This is the DEFAULT path for `worktree_abandon` (`mcp-tools.ts`
    // prefers `client.abandonWorktree`), so a designed refusal must arrive as
    // a designed refusal. `RUNTIME_STOP_FAILED` carries the pids in the way,
    // the `ps` command to inspect them and the pidfile to delete; an agent that
    // cannot see WHY abandon failed reaches for `rm -rf`, which is the incident
    // class this phase exists to prevent. 409 Conflict: the request was
    // well-formed and the server refused on state, not on input.
    if (
      err instanceof WorktreeError &&
      err.code === "RUNTIME_STOP_FAILED"
      // `client.post` throws `new Error(body.error)`, so the message reaches
      // the caller verbatim regardless of status — the status is for humans
      // and for anything reading the response directly.
    ) {
      return fail(err.message, 409);
    }
    throw err;
  }

  return ok({ worktree_id, status: "abandoned" });
}

async function handleCleanupWorktrees(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  // Read force/project/currentWorktree from the REQUEST BODY — never the
  // sidecar's process.cwd(), which is meaningless for the caller's project.
  const body = (await req.json().catch(() => ({}))) as {
    project?: string;
    force?: boolean;
    currentWorktree?: string;
  };
  const manager = new WorktreeManager(ctx.wtStore, runtimeWorktreeConfig());

  // ⛔ Guard 5's resolver is NOT read from the body and must never be — it
  // arrives on the manager config (`runtimeWorktreeConfig`) and is derived
  // server-side from each worktree's own pidfile. A caller-supplied "nothing is
  // running" would be a caller-supplied licence to delete a directory.
  const warnings: string[] = [];
  const cleaned = manager.cleanup({
    force: body.force === true,
    projectPath: body.project,
    currentWorktree: body.currentWorktree,
    // A plan is "active" if its spec exists and is IN_PROGRESS — never remove
    // its worktree during a force cleanup.
    isPlanActive: (slug) =>
      ctx.specStore.getSpec(slug)?.status === "IN_PROGRESS",
    warnings,
  });
  // ⛔ Sidecar mode is the DEFAULT path. A guard-5 skip computed here and
  // dropped leaves the caller with "Cleaned up 0 worktrees." and no reason —
  // and the obvious next move for an agent reading that is `rm -rf`, the exact
  // orphan the guard just prevented. `warnings` is additive on the response
  // body, so older clients that read only `cleaned` are unaffected.
  return ok(warnings.length > 0 ? { cleaned, warnings } : { cleaned });
}
