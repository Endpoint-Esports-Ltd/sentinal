/**
 * Sidecar Server
 *
 * Long-lived background process holding a warm MemoryStore.
 * Serves API endpoints over Unix domain socket (primary) with
 * HTTP localhost fallback. Used by hooks, MCP server, and the
 * OpenCode plugin to avoid per-invocation SQLite cold starts.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { logSidecar } from "../utils/file-log.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { handleSidecarRequest } from "./routes.js";
import { handleQualityRequest } from "./quality-routes.js";
import { handleProjectContextRequest } from "./project-routes.js";
import { handleTddTransitionRequest } from "./tdd-routes.js";
import { handleConfigRequest } from "./config-routes.js";
import { handleWorktreeRequest } from "./worktree-routes.js";
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
import {
  getSidecarSocketPath,
  getSidecarPortPath,
  getSidecarPidPath,
} from "./paths.js";

export interface SidecarContext {
  store: MemoryStore;
  service: MemoryService;
  specStore: SpecStore;
  wtStore: WorktreeStore;
  /** HTTP port for non-Unix-socket clients. Set after server starts. */
  httpPort?: number;
  /** LSP client for TypeScript diagnostics. Lazy-initialized on first use. */
  lspClient?: LspClient;
}

export interface SidecarServerOptions {
  /** Provide a pre-created store (for testing) */
  store?: MemoryStore;
  /** Force HTTP-only mode (no Unix socket) */
  httpOnly?: boolean;
  /** Specific port for HTTP fallback (0 = dynamic) */
  port?: number;
}

// ─── Session-Aware Lifecycle ─────────────────────────────────────────────────

/** Default check interval: 30 seconds */
export const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
/** Grace period after last session ends before shutdown (default: 60s) */
export const SESSION_GRACE_PERIOD_MS = 60 * 1000;
/** Idle timeout when no sessions have ever been created (default: 30 min) */
export const FALLBACK_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** If sessions exist but no HTTP activity for this long, treat as stale (default: 1h) */
export const STALE_ACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;

let lastActivityTime = Date.now();

/** Touch the activity timestamp. Called on every incoming request. */
export function touchActivity(): void {
  lastActivityTime = Date.now();
}

/** Get the last activity timestamp (for testing). */
export function getLastActivityTime(): number {
  return lastActivityTime;
}

export interface SessionAwareShutdownOptions {
  /** Grace period in ms after last session ends (default: 60s) */
  gracePeriodMs?: number;
  /** Idle timeout in ms when no sessions ever created (default: 30 min) */
  fallbackIdleMs?: number;
  /** Stale activity threshold in ms (default: 1h) */
  staleActivityMs?: number;
  /** How often to check in ms (default: 30s) */
  checkIntervalMs?: number;
  /** Custom shutdown callback (default: stopSidecar + process.exit) */
  onShutdown?: (reason: string) => void;
}

/**
 * Enable session-aware auto-shutdown for the sidecar.
 *
 * - Stays alive while any assistant session is active
 * - Shuts down after gracePeriodMs with zero active sessions
 * - Falls back to idle timeout when no sessions have ever been created (manual start)
 * - Detects stale sessions via HTTP activity threshold
 *
 * Returns a cleanup function that clears the interval.
 */
export function enableSessionAwareShutdown(
  result: SidecarStartResult,
  opts: SessionAwareShutdownOptions = {},
): () => void {
  const gracePeriodMs = opts.gracePeriodMs ?? SESSION_GRACE_PERIOD_MS;
  const fallbackIdleMs = opts.fallbackIdleMs ?? FALLBACK_IDLE_TIMEOUT_MS;
  const staleActivityMs = opts.staleActivityMs ?? STALE_ACTIVITY_THRESHOLD_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  touchActivity();

  let sessionsEverSeen = false;
  let noSessionSince: number | null = null;
  let staleInfo: { count: number; activityAge: number } | null = null;

  const doShutdown = (reason: string) => {
    clearInterval(interval);
    logSidecar(`sidecar: ${reason}`);
    if (opts.onShutdown) {
      opts.onShutdown(reason);
    } else {
      stopSidecar(result.server, result.ctx, result.httpServer);
      process.exit(0);
    }
  };

  const interval = setInterval(() => {
    const store = result.ctx.store;
    let activeSessions: unknown[];
    try {
      activeSessions = store.getActiveSessions();
    } catch {
      // Store closed or unavailable — treat as no sessions
      activeSessions = [];
    }

    if (activeSessions.length > 0) {
      // Sessions exist — check if they're actually alive (recent HTTP activity)
      const activityAge = Date.now() - lastActivityTime;
      if (activityAge >= staleActivityMs) {
        // No HTTP activity for staleActivityMs — sessions are likely from a crashed client
        // Capture stale context before falling through to grace-period logic
        staleInfo = { count: activeSessions.length, activityAge };
        // Fall through to the noSessionSince logic
      } else {
        // Active sessions with recent activity — stay alive
        sessionsEverSeen = true;
        noSessionSince = null;
        staleInfo = null;
        return;
      }
    } else {
      staleInfo = null;
    }

    // No active sessions (or stale sessions only)
    if (sessionsEverSeen) {
      if (noSessionSince === null) {
        noSessionSince = Date.now();
      } else if (Date.now() - noSessionSince >= gracePeriodMs) {
        const reason = staleInfo
          ? `shutting down: ${staleInfo.count} session(s) stale — no HTTP activity for ${staleInfo.activityAge}ms (threshold ${staleActivityMs}ms)`
          : `shutting down: 0 active sessions for ${gracePeriodMs}ms`;
        doShutdown(reason);
      }
    } else {
      // No sessions ever seen — hybrid idle fallback
      const idleMs = Date.now() - lastActivityTime;
      if (idleMs >= fallbackIdleMs) {
        doShutdown(`shutting down: no sessions ever created, idle ${idleMs}ms`);
      }
    }
  }, checkIntervalMs);

  if (interval.unref) interval.unref();

  return () => clearInterval(interval);
}

// ─── Stale Session Cleanup ───────────────────────────────────────────────────

/** Default stale session threshold: 24 hours */
const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Clean up sessions that have been active longer than the threshold.
 * Called on sidecar startup to prevent permanent session leaks.
 * Returns the number of sessions cleaned up.
 */
export function cleanupStaleSessionsOnStartup(store: MemoryStore): number {
  return store.cleanupStaleSessions(STALE_SESSION_THRESHOLD_MS);
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
  const store = opts.store ?? new MemoryStore();
  const service = new MemoryService(store);
  const specStore = new SpecStore(store);
  const wtStore = new WorktreeStore(store);
  const ctx: SidecarContext = { store, service, specStore, wtStore };

  // Clean up stale sessions from previous crashes/force-quits
  cleanupStaleSessionsOnStartup(store);

  const socketPath = getSidecarSocketPath();
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
    // Quality and project-context routes are in separate handlers to keep routes.ts under 400 lines
    const qualityResponse = await handleQualityRequest(req, ctx);
    if (qualityResponse) return qualityResponse;
    const projectResponse = await handleProjectContextRequest(req);
    if (projectResponse) return projectResponse;
    const tddResponse = await handleTddTransitionRequest(req, ctx);
    if (tddResponse) return tddResponse;
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
  return { server, ctx, transport: "http" };
}

/**
 * Graceful shutdown: close store, remove socket/port/pid files.
 *
 * PID guard: only removes artifact files if the PID file still belongs
 * to this process. If a newer sidecar has already written its own PID,
 * the files are left intact so the new sidecar remains discoverable.
 */
export function stopSidecar(
  server: ReturnType<typeof Bun.serve>,
  ctx: SidecarContext,
  httpServer?: ReturnType<typeof Bun.serve>,
): void {
  server.stop(true);
  if (httpServer) httpServer.stop(true);
  ctx.store.close();

  // Only clean up files if this process still owns them
  const pidPath = getSidecarPidPath();
  if (existsSync(pidPath)) {
    try {
      const filePid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isNaN(filePid) && filePid !== process.pid) {
        // A different sidecar owns these files — don't delete
        return;
      }
    } catch {
      /* read failed — safe to clean up */
    }
  }

  for (const path of [getSidecarSocketPath(), getSidecarPortPath(), pidPath]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
