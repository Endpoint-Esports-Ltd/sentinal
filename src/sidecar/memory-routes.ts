/**
 * Memory Sidecar Routes
 *
 *   POST /observation          add an observation (always the deduped path)
 *   GET  /context?project=     restore memory context for a session
 *   POST /memory/search|timeline|get|update|delete, GET /memory/stats
 *                              MCP delegation
 *
 * Dispatched from `handleSidecarRequest` (routes.ts) inside its try/catch.
 */

import { resolve } from "node:path";
import { resolveWorkspaceRoot } from "../project/identity.js";
import type { SidecarContext } from "./server.js";
import { ok, fail, readBody } from "./response.js";
import {
  MISSING_PROJECT_PATH,
  normalizeProjectFilter,
  normalizeProjectKey,
} from "./project-key.js";
import {
  buildVectorStats,
  notifyVectorUnavailableOnce,
} from "./vector-stats.js";
import { restoreContext } from "../memory/restore.js";
import type { ObservationType } from "../memory/types.js";

/** Handle the memory routes. Returns null for any other request. */
export async function handleMemoryRoute(
  url: URL,
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/observation" && method === "POST") {
    return handleAddObservation(req, ctx);
  }
  if (path === "/context" && method === "GET") {
    return handleRestoreContext(url, ctx);
  }
  if (path === "/memory/search" && method === "POST") {
    return handleMemorySearch(req, ctx);
  }
  if (path === "/memory/timeline" && method === "POST") {
    return handleMemoryTimeline(req, ctx);
  }
  if (path === "/memory/get" && method === "POST") {
    return handleMemoryGet(req, ctx);
  }
  if (path === "/memory/update" && method === "POST") {
    return handleMemoryUpdate(req, ctx);
  }
  if (path === "/memory/delete" && method === "POST") {
    return handleMemoryDelete(req, ctx);
  }
  if (path === "/memory/stats" && method === "GET") {
    return handleMemoryStats(ctx);
  }
  return null;
}

async function handleAddObservation(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    sessionId: string;
    projectPath: string;
    type: string;
    title: string;
    content: string;
    filePaths?: string[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>(req);

  const projectPath = normalizeProjectKey(body.projectPath);
  if (!projectPath) return fail(MISSING_PROJECT_PATH);

  const input = {
    sessionId: body.sessionId,
    projectPath,
    timestamp: Date.now(),
    type: body.type as ObservationType,
    title: body.title,
    content: body.content,
    filePaths: body.filePaths ?? [],
    tags: body.tags ?? [],
    metadata: body.metadata ?? {},
  };
  // D3/D10: ALWAYS the deduped path — the service decides eligibility (a
  // client error signature, an auto-capture source, or a dedupeKey), so every
  // client version's auto-captures collapse server-side. Eligible
  // observations gain `deduplicated` in the response; others are unchanged.
  const r = ctx.service.addObservationDeduped(input);
  return ok(
    r.deduplicable
      ? { ...r.observation, deduplicated: r.deduplicated }
      : r.observation,
  );
}

async function handleRestoreContext(
  url: URL,
  ctx: SidecarContext,
): Promise<Response> {
  // D3: the KEY is canonical. D8: shared memory is read from the WORKSPACE —
  // an explicit `workspace` param, else the local checkout of the raw
  // `project` (an old CC hook sends its raw cwd; the plugin sends identity,
  // whose workspace is the main checkout, i.e. unchanged behaviour).
  const rawProject = url.searchParams.get("project");
  const projectPath = normalizeProjectFilter(rawProject);
  if (!projectPath || !rawProject) {
    return fail("Missing 'project' query param");
  }
  const rawWorkspace = url.searchParams.get("workspace")?.trim();
  const workspacePath = rawWorkspace
    ? resolve(rawWorkspace)
    : resolveWorkspaceRoot(rawProject.trim());

  const semanticQuery = url.searchParams.get("semanticQuery") ?? undefined;
  const result = await restoreContext(ctx.service, {
    projectPath,
    workspacePath,
    semanticQuery,
  });
  return ok({ hasMemory: result.hasMemory, markdown: result.markdown });
}

async function handleMemorySearch(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    query: string;
    project?: string;
    type?: string;
    limit?: number;
  }>(req);
  // D3 — reads fail open: blank/absent = all projects; supplied = canonical.
  const results = await ctx.service.search(body.query, {
    project: normalizeProjectFilter(body.project),
    type: body.type as ObservationType | undefined,
    limit: body.limit ?? 20,
  });
  return ok(results);
}

async function handleMemoryTimeline(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    anchor: number;
    depth?: number;
    project?: string;
  }>(req);
  const d = body.depth ?? 5;
  const project = normalizeProjectFilter(body.project);
  const result = ctx.service.timeline(body.anchor, d, d, project);
  return ok(result);
}

async function handleMemoryGet(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{ ids: number[] }>(req);
  const observations = ctx.service.getObservations(body.ids);
  return ok(observations);
}

async function handleMemoryUpdate(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{
    id: number;
    title?: string;
    content?: string;
    type?: string;
    tags?: string[];
    filePaths?: string[];
  }>(req);
  // Goes through the SERVICE so the vector embedding is re-indexed too.
  const updated = ctx.service.updateObservation(body.id, {
    title: body.title,
    content: body.content,
    type: body.type as ObservationType | undefined,
    tags: body.tags,
    filePaths: body.filePaths,
  });
  return ok(updated);
}

async function handleMemoryDelete(
  req: Request,
  ctx: SidecarContext,
): Promise<Response> {
  const body = await readBody<{ id: number }>(req);
  // SERVICE delete removes the vector embedding, not just the FTS row.
  const deleted = ctx.service.deleteObservation(body.id);
  return ok({ deleted });
}

function handleMemoryStats(ctx: SidecarContext): Response {
  const stats = ctx.service.getStats();
  if (ctx.vectorState) {
    stats.vector = buildVectorStats(ctx.vectorState);
    if (ctx.vectorState.status === "unavailable") {
      // Lazy one-time alert — avoids touching server.ts's init path
      notifyVectorUnavailableOnce(ctx.store, ctx.vectorState.error);
    }
  }
  return ok(stats);
}
