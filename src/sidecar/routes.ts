/**
 * Sidecar API Routes
 *
 * All endpoints return JSON: { ok: true, data: ... } or { ok: false, error: "..." }
 * Used by hooks, MCP server, and OpenCode plugin via SidecarClient.
 */

import type { SidecarContext } from "./server.js";
import { restoreContext } from "../memory/restore.js";
import type {
  AssistantType,
  NotificationType,
  TddCycleState,
} from "../memory/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(data: unknown = null): Response {
  return json({ ok: true, data });
}

function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

// ─── Router ──────────────────────────────────────────────────────────────

export async function handleSidecarRequest(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health
    if (path === "/health" && method === "GET") {
      return ok({ status: "running", pid: process.pid, httpPort: ctx.httpPort ?? null });
    }

    // Ping — lightweight keep-alive for idle shutdown
    if (path === "/ping" && method === "GET") {
      return ok({ pong: true });
    }

    // Sessions
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

    // TDD State
    if (path === "/tdd-state" && method === "GET") {
      return handleGetTddState(url, ctx);
    }
    if (path === "/tdd-state" && method === "POST") {
      return handleSetTddState(req, ctx);
    }

    // Observations
    if (path === "/observation" && method === "POST") {
      return handleAddObservation(req, ctx);
    }

    // Memory context
    if (path === "/context" && method === "GET") {
      return handleRestoreContext(url, ctx);
    }

    // Specs
    if (path === "/spec/sync" && method === "POST") {
      return handleSyncSpec(req, ctx);
    }
    if (path === "/spec/current" && method === "GET") {
      return handleGetCurrentSpec(url, ctx);
    }

    // Memory search/timeline/get/stats (for MCP delegation)
    if (path === "/memory/search" && method === "POST") {
      return handleMemorySearch(req, ctx);
    }
    if (path === "/memory/timeline" && method === "POST") {
      return handleMemoryTimeline(req, ctx);
    }
    if (path === "/memory/get" && method === "POST") {
      return handleMemoryGet(req, ctx);
    }
    if (path === "/memory/stats" && method === "GET") {
      return handleMemoryStats(ctx);
    }

    // TDD State — list active
    if (path === "/tdd-state/list" && method === "GET") {
      return handleListTddStates(url, ctx);
    }

    // Spec events
    if (path === "/spec/events" && method === "GET") {
      return handleGetSpecEvents(url, ctx);
    }

    // Worktree — resolve by slug
    if (path === "/worktree/resolve" && method === "GET") {
      return handleResolveWorktree(url, ctx);
    }

    // Notifications
    if (path === "/notification" && method === "POST") {
      return handleInsertNotification(req, ctx);
    }

    return fail("Not found", 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`Internal error: ${message}`, 500);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────

async function handleCreateSession(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{
    id: string;
    projectPath: string;
    assistant: string;
    transcriptPath?: string | null;
  }>(req);

  try {
    const session = ctx.store.insertSession({
      id: body.id,
      startTime: Date.now(),
      endTime: null,
      projectPath: body.projectPath,
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
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{ summary?: string; notification?: boolean }>(
    req
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

function handleGetTddState(url: URL, ctx: SidecarContext): Response {
  const filePath = url.searchParams.get("file");
  const projectPath = url.searchParams.get("project");
  if (!filePath) return fail("Missing 'file' query param");

  const tddState = ctx.store.getTddState(filePath);
  let hasActiveSpec = false;
  if (projectPath) {
    const spec = ctx.specStore.getCurrentSpec(projectPath);
    hasActiveSpec = spec !== null;
  }

  return ok({ state: tddState?.state ?? "IDLE", hasActiveSpec });
}

async function handleSetTddState(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{
    action: "set" | "clear" | "clearForSpec";
    filePath?: string;
    specId?: string;
    state?: TddCycleState;
    taskPosition?: number;
    testFilePath?: string;
    lastFailOutput?: string;
  }>(req);

  if (body.action === "clear" && body.filePath) {
    ctx.store.clearTddState(body.filePath);
  } else if (body.action === "clearForSpec" && body.specId) {
    ctx.store.clearTddStatesForSpec(body.specId);
  } else if (body.action === "set" && body.filePath && body.state) {
    ctx.store.setTddState({
      filePath: body.filePath,
      state: body.state,
      specId: body.specId,
      taskPosition: body.taskPosition,
      testFilePath: body.testFilePath,
      lastFailOutput: body.lastFailOutput,
    });
  } else {
    return fail("Invalid action or missing required fields");
  }
  return ok();
}

async function handleAddObservation(
  req: Request,
  ctx: SidecarContext
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

  const obs = ctx.service.addObservation({
    sessionId: body.sessionId,
    projectPath: body.projectPath,
    timestamp: Date.now(),
    type: body.type as any,
    title: body.title,
    content: body.content,
    filePaths: body.filePaths ?? [],
    tags: body.tags ?? [],
    metadata: body.metadata ?? {},
  });
  return ok(obs);
}

function handleRestoreContext(url: URL, ctx: SidecarContext): Response {
  const projectPath = url.searchParams.get("project");
  if (!projectPath) return fail("Missing 'project' query param");

  const result = restoreContext(ctx.service, { projectPath });
  return ok({ hasMemory: result.hasMemory, markdown: result.markdown });
}

async function handleSyncSpec(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{ planPath: string; projectPath: string }>(req);
  ctx.specStore.syncFromPlanFile(body.planPath, body.projectPath);
  return ok();
}

function handleGetCurrentSpec(url: URL, ctx: SidecarContext): Response {
  const projectPath = url.searchParams.get("project");
  if (!projectPath) return fail("Missing 'project' query param");

  const spec = ctx.specStore.getCurrentSpec(projectPath);
  return ok(spec);
}

async function handleMemorySearch(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{
    query: string;
    project?: string;
    type?: string;
    limit?: number;
  }>(req);
  const results = await ctx.service.search(body.query, {
    project: body.project,
    type: body.type as any,
    limit: body.limit ?? 20,
  });
  return ok(results);
}

async function handleMemoryTimeline(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{
    anchor: number;
    depth?: number;
    project?: string;
  }>(req);
  const d = body.depth ?? 5;
  const result = ctx.service.timeline(body.anchor, d, d, body.project);
  return ok(result);
}

async function handleMemoryGet(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{ ids: number[] }>(req);
  const observations = ctx.service.getObservations(body.ids);
  return ok(observations);
}

function handleMemoryStats(ctx: SidecarContext): Response {
  const stats = ctx.service.getStats();
  return ok(stats);
}

async function handleInsertNotification(
  req: Request,
  ctx: SidecarContext
): Promise<Response> {
  const body = await readBody<{
    type: string;
    title: string;
    message?: string;
    source?: string;
    specId?: string;
    sessionId?: string;
  }>(req);

  const notif = ctx.store.insertNotification({
    type: body.type as NotificationType,
    title: body.title,
    message: body.message ?? null,
    source: body.source ?? null,
    specId: body.specId ?? null,
    sessionId: body.sessionId ?? null,
  });
  return ok(notif);
}

// ─── TDD State List ──────────────────────────────────────────────────────

function handleListTddStates(url: URL, ctx: SidecarContext): Response {
  const specId = url.searchParams.get("spec_id") || undefined;
  const states = ctx.store.listActiveTddStates(specId ?? null);
  return ok(states);
}

// ─── Spec Events ─────────────────────────────────────────────────────────

function handleGetSpecEvents(url: URL, ctx: SidecarContext): Response {
  const specId = url.searchParams.get("spec_id");
  if (!specId) return fail("Missing 'spec_id' query param");
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const events = ctx.store.getSpecEvents(specId, limit);
  return ok(events);
}

// ─── Worktree Resolve ────────────────────────────────────────────────────

function handleResolveWorktree(url: URL, ctx: SidecarContext): Response {
  const slug = url.searchParams.get("slug");
  if (!slug) return fail("Missing 'slug' query param");
  const project = url.searchParams.get("project") ?? undefined;
  const wt = ctx.wtStore.resolveBySlug(slug, project);
  return ok(wt);
}
