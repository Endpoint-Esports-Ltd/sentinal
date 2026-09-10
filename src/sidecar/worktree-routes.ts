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
import { logSidecar } from "../utils/file-log.js";
import { withIdempotency, withIdempotencyAsync } from "./idempotency.js";
import { ok, fail } from "./response.js";

// ─── Audit log ────────────────────────────────────────────────────────────────

/**
 * ⛔ Every worktree operation is logged server-side, start AND outcome
 * (issue #9).
 *
 * On a real machine `rg -c "worktree" ~/.sentinal/sidecar.log` returned **0**
 * immediately after a `--force` cleanup had deleted 7 worktrees and freed
 * 6.3 GB. The client had reported failure (a timeout misclassified as
 * "unreachable"), and because nothing was logged there was no way to establish
 * that the work had in fact completed except by inspecting git by hand.
 *
 * The client error is now honest about an unknown outcome — but "unknown" is
 * only actionable if the server recorded what it did. These two fixes are
 * complementary: one stops the lie, this one supplies the truth.
 *
 * The word "worktree" appears in every record because that is what an operator
 * greps for.
 */
function auditStart(op: string, detail: string): number {
  logSidecar(`worktree: ${op} start ${detail}`.trimEnd());
  return Date.now();
}

function auditEnd(op: string, startedAt: number, outcome: string): void {
  logSidecar(
    `worktree: ${op} ok ${outcome} in ${Date.now() - startedAt}ms`.replace(
      /\s+/g,
      " ",
    ),
  );
}

function auditFail(op: string, startedAt: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  logSidecar(
    `worktree: ${op} FAILED after ${Date.now() - startedAt}ms — ${msg}`,
  );
}

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

  // Captured before dispatch so the catch below can still time and name the
  // operation that threw.
  const op = `${method} ${pathname}`;
  const startedAt = Date.now();

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
    auditFail(op, startedAt, e);
    const msg = e instanceof Error ? e.message : String(e);
    return fail(msg, 500);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleResolveWorktree(url: URL, ctx: SidecarContext): Response {
  const slug = url.searchParams.get("slug");
  if (!slug) return fail("Missing 'slug' query param");
  const project = url.searchParams.get("project") ?? undefined;
  const startedAt = auditStart("GET /worktree/resolve", `slug=${slug}`);
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
  if (!wt) {
    auditEnd("GET /worktree/resolve", startedAt, `slug=${slug} found=false`);
    return ok(null);
  }

  const resolved: ResolvedWorktree = { ...wt };
  if (warnings.length > 0) resolved.warnings = warnings;
  auditEnd(
    "GET /worktree/resolve",
    startedAt,
    `slug=${slug} found=true path=${wt.worktreePath}`,
  );
  return ok(resolved);
}

async function handleAbandonWorktree(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = (await req.json()) as {
    worktree_id?: string;
    idempotencyKey?: string;
  };
  const { worktree_id } = body;

  if (!worktree_id) return fail("Missing 'worktree_id' in request body");

  const startedAt = auditStart(
    "POST /worktree/abandon",
    `worktree_id=${worktree_id}`,
  );

  const wt = ctx.wtStore.get(worktree_id);
  if (!wt) {
    auditEnd(
      "POST /worktree/abandon",
      startedAt,
      `worktree_id=${worktree_id} found=false`,
    );
    return fail(`Worktree ${worktree_id} not found`, 404);
  }

  const manager = new WorktreeManager(ctx.wtStore, runtimeWorktreeConfig());
  // ⛔ `abandon` is async because it stops the owned process group BEFORE it
  // removes the directory. Dropping this await would return "abandoned" while
  // the stop was still in flight, and surface a refusal as an unhandled
  // rejection instead of a response the caller can act on.
  // ⛔ Abandon stops an owned process group AND removes a directory. Unlike
  // cleanup, a second execution is NOT harmless, so the idempotency guard
  // matters more here than on the route that surfaced the bug.
  let replayed = false;
  try {
    const outcome = await withIdempotencyAsync(
      ctx.store,
      "worktree-abandon",
      body.idempotencyKey,
      async () => {
        await manager.abandon(worktree_id);
        return { worktree_id, status: "abandoned" as const };
      },
    );
    replayed = outcome.replayed;
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
      auditFail("POST /worktree/abandon", startedAt, err);
      return fail(err.message, 409);
    }
    auditFail("POST /worktree/abandon", startedAt, err);
    throw err;
  }

  auditEnd(
    "POST /worktree/abandon",
    startedAt,
    `worktree_id=${worktree_id} path=${wt.worktreePath}` +
      (replayed ? " REPLAYED (idempotency key hit)" : ""),
  );
  return ok({
    worktree_id,
    status: "abandoned",
    ...(replayed ? { replayed: true } : {}),
  });
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
    idempotencyKey?: string;
  };
  const manager = new WorktreeManager(ctx.wtStore, runtimeWorktreeConfig());

  // ⛔ Logged BEFORE the work starts. This is the record that survives a client
  // timeout: if the caller sees "outcome unknown", this line proves the request
  // arrived and the matching `ok`/`FAILED` line states what became of it.
  const startedAt = auditStart(
    "POST /worktree/cleanup",
    `project=${body.project ?? "(unscoped)"} force=${body.force === true} ` +
      `current=${body.currentWorktree ?? "(none)"}`,
  );

  // ⛔ Guard 5's resolver is NOT read from the body and must never be — it
  // arrives on the manager config (`runtimeWorktreeConfig`) and is derived
  // server-side from each worktree's own pidfile. A caller-supplied "nothing is
  // running" would be a caller-supplied licence to delete a directory.
  const warnings: string[] = [];
  // ⛔ The idempotency wrapper encloses the ENTIRE destructive call. A retry
  // carrying the same key replays the first outcome rather than deleting
  // again — the reporter retried twice after being told (wrongly) that the
  // operation had failed.
  const { result, replayed } = withIdempotency(
    ctx.store,
    "worktree-cleanup",
    body.idempotencyKey,
    () => {
      const r = manager.cleanup({
        force: body.force === true,
        projectPath: body.project,
        currentWorktree: body.currentWorktree,
        // A plan is "active" if its spec exists and is IN_PROGRESS — never
        // remove its worktree during a force cleanup.
        isPlanActive: (slug) =>
          ctx.specStore.getSpec(slug)?.status === "IN_PROGRESS",
        warnings,
      });
      // Warnings are captured INSIDE so a replay carries them too.
      return { ...r, warnings: [...warnings] };
    },
  );
  const { cleaned, removed } = result;
  const replayWarnings = result.warnings ?? [];
  // ⛔ Sidecar mode is the DEFAULT path. A guard-5 skip computed here and
  // dropped leaves the caller with "Cleaned up 0 worktrees." and no reason —
  // and the obvious next move for an agent reading that is `rm -rf`, the exact
  // orphan the guard just prevented. `warnings` is additive on the response
  // body, so older clients that read only `cleaned` are unaffected.
  auditEnd(
    "POST /worktree/cleanup",
    startedAt,
    `cleaned=${cleaned} skipped=${replayWarnings.length}` +
      (replayed ? " REPLAYED (idempotency key hit)" : "") +
      (removed.length > 0
        ? ` removed=[${removed.map((r) => r.path).join(", ")}]`
        : ""),
  );
  // ⛔ `cleaned` is UNCONDITIONAL. `removed` and `replayed` are additive — an
  // older client (notably the bundled OpenCode plugin) reads only `cleaned`
  // and must keep working against a newer sidecar.
  return ok({
    cleaned,
    removed,
    ...(replayWarnings.length > 0 ? { warnings: replayWarnings } : {}),
    ...(replayed ? { replayed: true } : {}),
  });
}
