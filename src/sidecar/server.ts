/**
 * Sidecar Server
 *
 * Long-lived background process holding a warm MemoryStore.
 * Serves API endpoints over Unix domain socket (primary) with
 * HTTP localhost fallback. Used by hooks, MCP server, and the
 * OpenCode plugin to avoid per-invocation SQLite cold starts.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { handleSidecarRequest } from "./routes.js";

// Re-export path helpers for backward compatibility
export {
  SIDECAR_SOCKET, SIDECAR_PORT_FILE, SIDECAR_PID_FILE,
  getSidecarSocketPath, getSidecarPortPath, getSidecarPidPath,
} from "./paths.js";
import { getSidecarSocketPath, getSidecarPortPath, getSidecarPidPath } from "./paths.js";

export interface SidecarContext {
  store: MemoryStore;
  service: MemoryService;
  specStore: SpecStore;
}

export interface SidecarServerOptions {
  /** Provide a pre-created store (for testing) */
  store?: MemoryStore;
  /** Force HTTP-only mode (no Unix socket) */
  httpOnly?: boolean;
  /** Specific port for HTTP fallback (0 = dynamic) */
  port?: number;
}

/**
 * Start the sidecar server. Returns the Bun server instance.
 *
 * Primary: Unix domain socket at ~/.sentinal/sidecar.sock
 * Fallback: HTTP on 127.0.0.1 with dynamic port
 */
export function startSidecar(opts: SidecarServerOptions = {}): {
  server: ReturnType<typeof Bun.serve>;
  httpServer?: ReturnType<typeof Bun.serve>;
  ctx: SidecarContext;
  transport: "unix" | "http";
} {
  const store = opts.store ?? new MemoryStore();
  const service = new MemoryService(store);
  const specStore = new SpecStore(store);
  const ctx: SidecarContext = { store, service, specStore };

  const socketPath = getSidecarSocketPath();
  const useUnix = !opts.httpOnly && process.platform !== "win32";

  // Clean stale socket file
  if (useUnix && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  const fetchHandler = (req: Request) => handleSidecarRequest(req, ctx);

  if (useUnix) {
    try {
      const server = Bun.serve({ unix: socketPath, fetch: fetchHandler });
      // Also bind HTTP for non-Bun clients (e.g. OpenCode's Node.js runtime)
      const httpServer = Bun.serve({
        port: opts.port ?? 0,
        hostname: "127.0.0.1",
        fetch: fetchHandler,
      });
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
  });
  writeFileSync(getSidecarPortPath(), String(server.port), "utf-8");
  return { server, ctx, transport: "http" };
}

/**
 * Graceful shutdown: close store, remove socket/port/pid files.
 */
export function stopSidecar(
  server: ReturnType<typeof Bun.serve>,
  ctx: SidecarContext,
  httpServer?: ReturnType<typeof Bun.serve>,
): void {
  server.stop(true);
  if (httpServer) httpServer.stop(true);
  ctx.store.close();

  for (const path of [getSidecarSocketPath(), getSidecarPortPath(), getSidecarPidPath()]) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
  }
}
