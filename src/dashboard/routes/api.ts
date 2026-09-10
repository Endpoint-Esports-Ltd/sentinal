/**
 * Dashboard API Routes
 *
 * JSON endpoints for the console dashboard.
 * All handlers receive a MemoryStore and return Response objects.
 */

import { z } from "zod";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";
import {
  getModelRouting,
  setModelRouting,
} from "../../config/model-routing.js";
import type { SearchFilters, ObservationType } from "../../memory/types.js";
import { SearchFiltersSchema, OBSERVATION_TYPES } from "../../memory/types.js";

export interface ApiContext {
  store: MemoryStore;
  specStore: SpecStore;
  version: string;
}

// ─── Health ─────────────────────────────────────────────────────────────────

export function healthHandler(ctx: ApiContext): Response {
  return json({ status: "ok", version: ctx.version, pid: process.pid });
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export function dashboardHandler(ctx: ApiContext): Response {
  const activeSessions = ctx.store.getActiveSessions();
  const recentSpecs = ctx.specStore.listAllSpecs(5);
  const notifications = ctx.store.getNotifications({ limit: 10 });
  const stats = ctx.store.getStats();

  return json({ activeSessions, recentSpecs, notifications, stats });
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export function sessionsHandler(ctx: ApiContext, url: URL): Response {
  const active = url.searchParams.get("active");
  const project = url.searchParams.get("project") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const sessions = ctx.store.listSessions({
    active: active === "true" ? true : active === "false" ? false : undefined,
    project,
    limit,
    offset,
  });

  return json({ sessions, total: sessions.length });
}

// ─── Specs ──────────────────────────────────────────────────────────────────

export function specsHandler(ctx: ApiContext): Response {
  const specs = ctx.specStore.listAllSpecs(100);
  return json({ specs });
}

export function specDetailHandler(ctx: ApiContext, id: string): Response {
  const spec = ctx.specStore.getSpec(id);
  if (!spec) return json({ error: "Spec not found" }, 404);
  return json({ spec });
}

// ─── Memories ───────────────────────────────────────────────────────────────

export function memoriesHandler(ctx: ApiContext, url: URL): Response {
  const query = url.searchParams.get("q") ?? "";
  const type = url.searchParams.get("type") as ObservationType | null;
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = 20;
  const offset = (page - 1) * limit;

  const filters: Partial<SearchFilters> = {
    limit,
    offset,
    orderBy: "date_desc",
  };
  if (type && OBSERVATION_TYPES.includes(type)) {
    filters.type = type;
  }

  let observations;
  if (query) {
    try {
      observations = ctx.store.searchFTS(
        query,
        SearchFiltersSchema.parse(filters),
      );
    } catch {
      observations = ctx.store.searchFilters(
        SearchFiltersSchema.parse(filters),
      );
    }
  } else {
    observations = ctx.store.searchFilters(SearchFiltersSchema.parse(filters));
  }

  return json({ observations, page, limit });
}

// ─── Notifications ──────────────────────────────────────────────────────────

export function notificationsHandler(ctx: ApiContext, url: URL): Response {
  const unread = url.searchParams.get("unread") === "true";
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const notifications = ctx.store.getNotifications({ unread, limit });
  const unreadCount = ctx.store.getUnreadNotificationCount();
  return json({ notifications, unreadCount });
}

export function markAllNotificationsReadHandler(ctx: ApiContext): Response {
  ctx.store.markAllNotificationsRead();
  return json({ success: true });
}

export function markNotificationReadHandler(
  ctx: ApiContext,
  id: number,
): Response {
  ctx.store.markNotificationRead(id);
  return json({ success: true });
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function settingsGetHandler(ctx: ApiContext): Response {
  const modelRouting = getModelRouting(ctx.store);
  const allSettings = ctx.store.listSettings();
  return json({ modelRouting, allSettings });
}

/**
 * Accepted POST /api/settings body. Known keys only — unknown top-level keys
 * and unknown/non-string modelRouting values are rejected with a 400.
 *
 * NOTE: fields are listed explicitly (with `satisfies` drift protection
 * against ModelRouting) instead of `ModelRoutingSchema.partial()` because
 * that schema carries `.default()`s, and a partial parse must NOT inject
 * defaults for fields the client did not send.
 */
const SettingsPostSchema = z
  .object({
    modelRouting: z
      .object({
        planning: z.string(),
        implementation: z.string(),
        verification: z.string(),
        plan_reviewer: z.string(),
        spec_reviewer: z.string(),
      } satisfies Record<
        keyof import("../../config/types.js").ModelRouting,
        unknown
      >)
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export async function settingsPostHandler(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = SettingsPostSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: `Invalid settings body: ${parsed.error.issues[0]?.message}` },
      400,
    );
  }

  if (parsed.data.modelRouting) {
    setModelRouting(ctx.store, parsed.data.modelRouting);
  }
  return json({ success: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
