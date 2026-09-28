/**
 * Sidecar Server
 *
 * Long-lived background process holding a warm MemoryStore.
 * Serves API endpoints over Unix domain socket (primary) with
 * HTTP localhost fallback. Used by hooks, MCP server, and the
 * OpenCode plugin to avoid per-invocation SQLite cold starts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { logSidecar } from "../utils/file-log.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { loadCustomSqlite } from "../memory/vector-store.js";
import { runAutoDecayIfStale } from "../memory/auto-decay.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { handleSidecarRequest } from "./routes.js";
import { handleQualityRequest } from "./quality-routes.js";
import { handleProjectContextRequest } from "./project-routes.js";
import { handleTddTransitionRequest } from "./tdd-routes.js";
import { handleSpecMetricsRequest } from "./spec-routes.js";
import { handleConfigRequest } from "./config-routes.js";
import { handleWorktreeRequest } from "./worktree-routes.js";
import { handleNotificationRequest } from "./notification-routes.js";
import { handleRetireRequest, type RetireRequest } from "./retire-routes.js";
import { LspClient } from "./lsp-client.js";

// Re-export path helpers for backward compatibility
export {
  SIDECAR_SOCKET,
  SIDECAR_PORT_FILE,
  SIDECAR_PID_FILE,
  getSidecarSocketPath,
  getSidecarPortPath,
  getSidecarPidPath,
} from "./paths.js";
import { getSidecarSocketPath, getSidecarPortPath } from "./paths.js";

// Session-aware shutdown, activity tracking and the graceful stop live in
// shutdown.ts; re-exported so `./server.js` stays the public import path.
export {
  DEFAULT_CHECK_INTERVAL_MS,
  SESSION_GRACE_PERIOD_MS,
  FALLBACK_IDLE_TIMEOUT_MS,
  STALE_ACTIVITY_THRESHOLD_MS,
  touchActivity,
  getLastActivityTime,
  enableSessionAwareShutdown,
  cleanupStaleSessionsOnStartup,
  stopSidecar,
  type SessionAwareShutdownOptions,
} from "./shutdown.js";
import { touchActivity, cleanupStaleSessionsOnStartup } from "./shutdown.js";

// Vector init lives in vector-init.ts; re-exported for backward compatibility.
export {
  initVectorSearch,
  startBackgroundVectorInit,
  vectorSearchEnabled,
  type VectorSearchState,
  type InitVectorSearchDeps,
} from "./vector-init.js";
import {
  startBackgroundVectorInit,
  vectorSearchEnabled,
} from "./vector-init.js";
import type { VectorSearchState } from "./vector-init.js";

export interface SidecarContext {
  store: MemoryStore;
  service: MemoryService;
  specStore: SpecStore;
  wtStore: WorktreeStore;
  /** HTTP port for non-Unix-socket clients. Set after server starts. */
  httpPort?: number;
  /** LSP client for TypeScript diagnostics. Lazy-initialized on first use. */
  lspClient?: LspClient;
  /** Vector search init state. Set by initVectorSearch after listen. */
  vectorState?: VectorSearchState;
  /** Set once by POST /retire or the staleness poll; read by the shutdown loop. */
  retire?: RetireRequest;
}

export interface SidecarServerOptions {
  /** Provide a pre-created store (for testing) */
  store?: MemoryStore;
  /** Force HTTP-only mode (no Unix socket) */
  httpOnly?: boolean;
  /** Specific port for HTTP fallback (0 = dynamic) */
  port?: number;
  /**
   * Initialize semantic vector search in the background after listen
   * (default true). Tests pass false to avoid model loads. Also disabled
   * by env SENTINAL_DISABLE_VECTOR_SEARCH=1 (subprocess-spawned sidecars).
   */
  enableVectorSearch?: boolean;
}

/**
 * Schedule the throttled quality-score decay OFF the hot path (after listen).
 * The sidecar boots ~once per work-session, so the 24h throttle gives natural
 * ~daily decay. Best-effort — `runAutoDecayIfStale` never throws, and this is
 * deferred via `queueMicrotask` so it can never delay the listen path.
 */
function scheduleStartupDecay(store: MemoryStore): void {
  queueMicrotask(() => {
    try {
      const result = runAutoDecayIfStale(store);
      if (result.ran) {
        logSidecar(
          `sidecar: startup decay ran (${result.updated ?? 0} updated)`,
        );
      }
    } catch {
      /* best-effort — decay must never affect the sidecar */
    }
  });
}

/**
 * Start the sidecar server. Returns the Bun server instance.
 *
 * Primary: Unix domain socket at ~/.sentinal/sidecar.sock
 * Fallback: HTTP on 127.0.0.1 with dynamic port
 */
export interface SidecarStartResult {
  server: ReturnType<typeof Bun.serve>;
  httpServer?: ReturnType<typeof Bun.serve>;
  ctx: SidecarContext;
  transport: "unix" | "http";
  /** True if another sidecar was already running — caller should exit cleanly. */
  alreadyRunning?: boolean;
}

export async function startSidecar(
  opts: SidecarServerOptions = {},
): Promise<SidecarStartResult> {
  const vectorEnabled = vectorSearchEnabled(opts);
  // macOS requires Database.setCustomSQLite BEFORE any Database instance
  // exists in the process — must run before the MemoryStore below.
  if (vectorEnabled) {
    loadCustomSqlite();
  }
  const store = opts.store ?? new MemoryStore();
  const service = new MemoryService(store);
  const specStore = new SpecStore(store);
  const wtStore = new WorktreeStore(store);
  const ctx: SidecarContext = { store, service, specStore, wtStore };

  // Clean up stale sessions from previous crashes/force-quits
  cleanupStaleSessionsOnStartup(store);

  const socketPath = getSidecarSocketPath();
  // Ensure the state directory exists before any pid/port/socket file writes.
  // On fresh machines (CI runners) ~/.sentinal has never been created and
  // writeFileSync below would throw ENOENT.
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
  } catch {
    /* non-fatal — subsequent writes will surface a real permission problem */
  }
  const useUnix = !opts.httpOnly && process.platform !== "win32";

  // If the socket file exists, probe it before removing — another sidecar may be live
  if (useUnix && existsSync(socketPath)) {
    try {
      const probe = await fetch("http://localhost/health", {
        unix: socketPath,
      } as RequestInit);
      if (probe.ok) {
        // Another sidecar is already serving — sync the port file from its health response
        try {
          const health = (await probe.json()) as {
            data?: { httpPort?: number };
          };
          const livePort = health?.data?.httpPort;
          if (typeof livePort === "number" && livePort > 0) {
            const portPath = getSidecarPortPath();
            let filePort: number | null = null;
            try {
              const content = readFileSync(portPath, "utf-8").trim();
              filePort = parseInt(content, 10);
              if (Number.isNaN(filePort)) filePort = null;
            } catch {
              /* no port file */
            }
            if (filePort !== livePort) {
              writeFileSync(portPath, String(livePort), "utf-8");
            }
          }
        } catch {
          /* non-fatal — port sync is best-effort */
        }

        logSidecar("sidecar: start skipped — already running on socket");
        return {
          server: null as unknown as ReturnType<typeof Bun.serve>,
          ctx,
          transport: "unix",
          alreadyRunning: true,
        };
      }
    } catch {
      /* socket is stale, safe to remove */
    }
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
  }

  const fetchHandler = async (req: Request) => {
    touchActivity();
    const retireResponse = await handleRetireRequest(req, ctx);
    if (retireResponse) return retireResponse;
    const notificationResponse = await handleNotificationRequest(req, ctx);
    if (notificationResponse) return notificationResponse;
    // Quality and project-context routes are in separate handlers to keep routes.ts under 400 lines
    const qualityResponse = await handleQualityRequest(req, ctx);
    if (qualityResponse) return qualityResponse;
    const projectResponse = await handleProjectContextRequest(req);
    if (projectResponse) return projectResponse;
    const tddResponse = await handleTddTransitionRequest(req, ctx);
    if (tddResponse) return tddResponse;
    const specResponse = await handleSpecMetricsRequest(req, ctx);
    if (specResponse) return specResponse;
    const configResponse = await handleConfigRequest(req, ctx);
    if (configResponse) return configResponse;
    const worktreeResponse = await handleWorktreeRequest(req, ctx);
    if (worktreeResponse) return worktreeResponse;
    return handleSidecarRequest(req, ctx);
  };

  // Defense-in-depth: ensure uncaught errors return JSON, not Bun's default HTML
  const errorHandler = (err: Error) =>
    Response.json(
      { ok: false, error: `Internal error: ${err.message}` },
      { status: 500 },
    );

  if (useUnix) {
    try {
      const server = Bun.serve({
        unix: socketPath,
        fetch: fetchHandler,
        error: errorHandler,
      });
      // Also bind HTTP for non-Bun clients (e.g. OpenCode's Node.js runtime)
      const httpServer = Bun.serve({
        port: opts.port ?? 0,
        hostname: "127.0.0.1",
        fetch: fetchHandler,
        error: errorHandler,
      });
      ctx.httpPort = httpServer.port;
      writeFileSync(getSidecarPortPath(), String(httpServer.port), "utf-8");
      startBackgroundVectorInit(ctx, vectorEnabled);
      scheduleStartupDecay(store);
      return { server, httpServer, ctx, transport: "unix" };
    } catch {
      // Unix socket failed — fall through to HTTP-only
    }
  }

  // HTTP fallback (or httpOnly mode)
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    fetch: fetchHandler,
    error: errorHandler,
  });
  ctx.httpPort = server.port;
  writeFileSync(getSidecarPortPath(), String(server.port), "utf-8");
  startBackgroundVectorInit(ctx, vectorEnabled);
  scheduleStartupDecay(store);
  return { server, ctx, transport: "http" };
}
