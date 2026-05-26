/**
 * Dashboard HTTP Server
 *
 * Bun.serve() based HTTP server with URL pathname routing.
 * Serves HTML views and JSON API endpoints.
 */

// No Server type import needed — we use ReturnType<typeof Bun.serve>
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { layout } from "./views/layout.js";
import {
  dashboardView,
  dashboardFragment,
  type DashboardData,
} from "./views/dashboard.js";
import {
  healthHandler,
  dashboardHandler,
  sessionsHandler,
  specsHandler,
  specDetailHandler,
  memoriesHandler,
  notificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
  settingsGetHandler,
  settingsPostHandler,
  type ApiContext,
} from "./routes/api.js";

export interface ServerOptions {
  port: number;
  host: string;
  version: string;
  store?: MemoryStore;
}

export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const store = opts.store ?? new MemoryStore();
  const specStore = new SpecStore(store);
  const ctx: ApiContext = { store, specStore, version: opts.version };

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch(req) {
      return handleRequest(req, ctx);
    },
  });

  return server;
}

async function handleRequest(req: Request, ctx: ApiContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Add common headers
  const addHeaders = (res: Response): Response => {
    res.headers.set("X-Sentinal-Version", ctx.version);
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return res;
  };

  // CORS preflight
  if (method === "OPTIONS") {
    return addHeaders(new Response(null, { status: 204 }));
  }

  try {
    let response: Response;

    // ─── API Routes ───────────────────────────────────────────────
    if (path === "/api/health") {
      response = healthHandler(ctx);
    } else if (path === "/api/dashboard") {
      response = dashboardHandler(ctx);
    } else if (path === "/api/sessions") {
      response = sessionsHandler(ctx, url);
    } else if (path === "/api/specs" && method === "GET") {
      response = specsHandler(ctx);
    } else if (path.startsWith("/api/specs/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/specs/".length));
      response = specDetailHandler(ctx, id);
    } else if (path === "/api/memories") {
      response = memoriesHandler(ctx, url);
    } else if (path === "/api/notifications" && method === "GET") {
      response = notificationsHandler(ctx, url);
    } else if (path === "/api/notifications/read" && method === "POST") {
      response = markAllNotificationsReadHandler(ctx);
    } else if (
      path.match(/^\/api\/notifications\/\d+\/read$/) &&
      method === "POST"
    ) {
      const id = parseInt(path.split("/")[3], 10);
      response = markNotificationReadHandler(ctx, id);
    } else if (path === "/api/settings" && method === "GET") {
      response = settingsGetHandler(ctx);
    } else if (path === "/api/settings" && method === "POST") {
      response = await settingsPostHandler(ctx, req);

      // ─── Fragment Routes (htmx partial swaps) ─────────────────────
    } else if (path === "/fragments/dashboard") {
      const data = getDashboardData(ctx);
      response = html(dashboardFragment(data));
    } else if (path === "/fragments/memories") {
      const { memoriesListFragment } = await import("./views/memories.js");
      const q = url.searchParams.get("q") ?? "";
      const typeParam = url.searchParams.get("type") ?? undefined;
      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const offset = (page - 1) * 20;
      const filterType = typeParam as
        | import("../memory/types.js").ObservationType
        | undefined;
      const observations = q
        ? ctx.store.searchFTS(q, {
            limit: 20,
            offset,
            orderBy: "relevance",
            exactMatch: false,
            type: filterType,
          })
        : ctx.store.searchFilters({
            limit: 20,
            offset,
            orderBy: "date_desc",
            exactMatch: false,
            type: filterType,
          });
      response = html(memoriesListFragment(observations, page));
    } else if (path === "/fragments/sessions") {
      const { sessionsFragment } = await import("./views/sessions.js");
      const active = ctx.store.getActiveSessions();
      const ended = ctx.store.listSessions({ limit: 50 });
      response = html(sessionsFragment(active, ended));

      // ─── HTML View Routes ─────────────────────────────────────────
    } else if (path === "/") {
      const data = getDashboardData(ctx);
      const unread = ctx.store.getUnreadNotificationCount();
      response = html(
        layout(
          "Dashboard",
          dashboardView(data),
          "dashboard",
          unread,
          ctx.version,
        ),
      );
    } else if (path === "/specifications") {
      response = await renderView("specifications", ctx);
    } else if (path === "/memories") {
      response = await renderView("memories", ctx);
    } else if (path === "/sessions") {
      response = await renderView("sessions", ctx);
    } else if (path === "/settings") {
      response = await renderView("settings", ctx);

      // ─── 404 ──────────────────────────────────────────────────────
    } else {
      response = html(
        layout(
          "Not Found",
          '<p class="text-gray-400">Page not found.</p>',
          "dashboard",
          0,
          ctx.version,
        ),
        404,
      );
    }

    return addHeaders(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return addHeaders(
      new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

function getDashboardData(ctx: ApiContext): DashboardData {
  return {
    activeSessions: ctx.store.getActiveSessions(),
    recentSpecs: ctx.specStore.listAllSpecs(5),
    notifications: ctx.store.getNotifications({ limit: 10 }),
    stats: ctx.store.getStats(),
  };
}

/**
 * Render a placeholder view. View implementations are added in Tasks 9.2-9.5.
 * Once implemented, this function dispatches to the real view.
 */
async function renderView(
  page: "specifications" | "memories" | "sessions" | "settings",
  ctx: ApiContext,
): Promise<Response> {
  const unread = ctx.store.getUnreadNotificationCount();
  const titles: Record<string, string> = {
    specifications: "Specifications",
    memories: "Memories",
    sessions: "Sessions",
    settings: "Settings",
  };

  // Dynamic imports — views are added incrementally
  let content: string;
  try {
    switch (page) {
      case "specifications": {
        const { specificationsView } =
          await import("./views/specifications.js");
        const specs = ctx.specStore.listAllSpecs(100);
        content = specificationsView(specs);
        break;
      }
      case "memories": {
        const { memoriesView } = await import("./views/memories.js");
        const observations = ctx.store.searchFilters({
          limit: 20,
          offset: 0,
          orderBy: "date_desc",
          exactMatch: false,
        });
        content = memoriesView(observations);
        break;
      }
      case "sessions": {
        const { sessionsView } = await import("./views/sessions.js");
        const sessions = ctx.store.listSessions({ limit: 50 });
        content = sessionsView(sessions);
        break;
      }
      case "settings": {
        const { settingsView } = await import("./views/settings.js");
        const { getModelRouting } = await import("../config/model-routing.js");
        const modelRouting = getModelRouting(ctx.store);
        content = settingsView(modelRouting, ctx.version, ctx.store);
        break;
      }
    }
  } catch {
    content = `<p class="text-gray-400">This view is not yet implemented.</p>`;
  }

  return html(layout(titles[page], content, page, unread, ctx.version));
}

function html(body: string, status: number = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
