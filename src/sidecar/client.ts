/**
 * Sidecar Client
 *
 * Connects to the sidecar server via Unix socket (preferred) or HTTP fallback.
 * Used by hooks, MCP server, and OpenCode plugin to avoid per-invocation
 * MemoryStore cold starts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getSidecarSocketPath, getSidecarPortPath } from "./paths.js";
import { logSidecar } from "../utils/file-log.js";
import { SidecarRoutes } from "./client-routes.js";
export type { QualityCheckResult } from "./quality-routes.js";

// ─── Request timeouts ──────────────────────────────────────────────────────

/**
 * Path-pattern → request timeout budget (H8). Without a bound, a sidecar
 * that is alive-but-hung stalls every sync hook to its full hooks.json
 * timeout. Follows the AbortSignal.timeout pattern from lifecycle.ts.
 *
 * - /quality-check runs tsc/eslint/prettier subprocesses SEQUENTIALLY, each
 *   with its own server-side timeout (default 30s; callers pass up to 60s,
 *   and prettier spawns twice) — the budget must cover the whole run + margin.
 * - Embedding-backed (/observation, /memory/*, /context — cold
 *   @xenova/transformers model load) and git/fs-backed (/worktree/*,
 *   /spec/sync, /project-context) routes get a moderate budget.
 * - Everything else is DB-only and must answer fast (default 2s, matching
 *   lifecycle.ts health probes).
 *
 * spec_wait_file's long-poll does NOT go through this client — it is pure
 * fs-watching in src/spec/mcp-tools.ts — so no entry is needed for it.
 */
const REQUEST_TIMEOUTS: Array<[RegExp, number]> = [
  [/^\/quality-check/, 180_000],
  [
    /^\/(observation|context|memory\/|spec\/sync|worktree\/|project-context)/,
    30_000,
  ],
];
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

/** Resolve the request timeout budget for a sidecar route path. */
export function requestTimeoutMsFor(path: string): number {
  for (const [pattern, ms] of REQUEST_TIMEOUTS) {
    if (pattern.test(path)) return ms;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export class SidecarClient extends SidecarRoutes {
  // ─── Self-healing reconnect knobs (overridable in tests) ────────────────

  /**
   * Respawn hook invoked when a request fails and no live sidecar can be
   * found. Defaults to `autoStartSidecar()` (spawns `sentinal sidecar start`
   * detached). Tests override this to avoid spawning real processes.
   */
  static autoStartFn: () => void = () => {
    try {
      // Lazy require keeps hook startup cost minimal (no bun:sqlite pull-in).
      const { autoStartSidecar } = require("./lifecycle.js");
      autoStartSidecar();
    } catch {
      /* non-fatal — reconnect polling will simply fail */
    }
  };

  /** How many times to poll for a live sidecar after autoStartFn. */
  static reconnectAttempts = 10;
  /** Delay between reconnect polls in ms. */
  static reconnectDelayMs = 200;

  private constructor(
    private baseUrl: string,
    private fetchOpts: RequestInit & { unix?: string },
    private readonly reconnectEnabled = false,
  ) {
    super();
  }

  /** Build a client for a known base URL (for testing only). */
  static buildForTest(baseUrl: string): SidecarClient {
    return new SidecarClient(baseUrl, {});
  }

  /**
   * Connect to the running sidecar. Returns null if sidecar is not running.
   * Tries Unix socket first, then HTTP port file fallback.
   */
  static async connect(): Promise<SidecarClient | null> {
    return SidecarClient.tryConnect();
  }

  /**
   * Connect with retry. Use after autoStartSidecar() to wait for the
   * sidecar to come up. Retries `attempts` times with `delayMs` between.
   */
  static async connectWithRetry(
    attempts = 10,
    delayMs = 200,
  ): Promise<SidecarClient | null> {
    for (let i = 0; i < attempts; i++) {
      const client = await SidecarClient.tryConnect();
      if (client) return client;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return null;
  }

  private static async tryConnect(): Promise<SidecarClient | null> {
    // Try Unix socket
    const socketPath = getSidecarSocketPath();
    if (existsSync(socketPath)) {
      // Probe with a NON-reconnecting client — a reconnect-enabled probe
      // would recurse (health → reconnect → tryConnect → health → ...)
      // when the socket file is stale.
      const probe = new SidecarClient("http://localhost", {
        unix: socketPath,
      });
      try {
        const health = await probe.health();

        // Self-heal: sync the HTTP port file from the health response
        // so Node.js clients (which can't use Unix sockets) find the right port
        SidecarClient.syncPortFile(health.httpPort);

        return new SidecarClient(
          "http://localhost",
          { unix: socketPath },
          true,
        );
      } catch {
        /* socket exists but not responding */
      }
    }

    // Try HTTP port file
    const portPath = getSidecarPortPath();
    if (existsSync(portPath)) {
      try {
        const content = readFileSync(portPath, "utf-8").trim();
        if (content === "unix") return null; // socket mode but socket failed
        const port = parseInt(content, 10);
        if (Number.isNaN(port)) return null;
        const probe = new SidecarClient(`http://127.0.0.1:${port}`, {});
        await probe.health();
        return new SidecarClient(`http://127.0.0.1:${port}`, {}, true);
      } catch {
        /* port file exists but server not responding */
      }
    }

    return null;
  }

  // ─── Self-healing reconnect ──────────────────────────────────────────────

  /**
   * The sidecar legitimately restarts (session-aware shutdown), so a cached
   * client's transport can go stale. Re-resolve the transport; if no live
   * sidecar is found, ask autoStartFn to respawn one and poll briefly.
   * On success, heal this instance in place so future requests work too.
   */
  private async reconnect(): Promise<boolean> {
    let fresh = await SidecarClient.tryConnect();

    if (!fresh) {
      logSidecar("client: no live sidecar — respawn triggered");
      SidecarClient.autoStartFn();
      for (let i = 0; i < SidecarClient.reconnectAttempts && !fresh; i++) {
        await new Promise((r) => setTimeout(r, SidecarClient.reconnectDelayMs));
        fresh = await SidecarClient.tryConnect();
      }
    }

    if (!fresh) {
      logSidecar(
        `client: reconnect failed after ${SidecarClient.reconnectAttempts} attempts`,
      );
      return false;
    }
    this.baseUrl = fresh.baseUrl;
    this.fetchOpts = fresh.fetchOpts;
    logSidecar(`client: reconnected via ${this.target()}`);
    return true;
  }

  /** Human-readable transport target for error messages. */
  private target(): string {
    return this.fetchOpts.unix ? `unix:${this.fetchOpts.unix}` : this.baseUrl;
  }

  /**
   * Perform a fetch with one reconnect-and-retry on connection-level
   * failures. A connection failure (e.g. ECONNREFUSED) means the request
   * never reached the server, so retrying is always safe — no idempotency
   * concerns. HTTP-level and `ok: false` errors are NOT retried.
   */
  private async fetchWithReconnect(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...this.fetchOpts,
        ...init,
      });
    } catch (err) {
      // A timeout means the request may have REACHED the server (it is
      // alive-but-slow/hung) — retrying is not connection-safe and would
      // double the wait. Only pure connection failures reconnect-retry.
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      if (isTimeout || !this.reconnectEnabled) {
        throw SidecarClient.enrich(err, init.method ?? "GET", path, this);
      }
      logSidecar(
        `client: connection lost (${init.method ?? "GET"} ${path}) — reconnecting`,
      );
      if (!(await this.reconnect())) {
        throw SidecarClient.enrich(err, init.method ?? "GET", path, this);
      }
      try {
        return await fetch(`${this.baseUrl}${path}`, {
          ...this.fetchOpts,
          ...init,
          // Fresh budget — reconnect polling may have consumed the original.
          signal: AbortSignal.timeout(requestTimeoutMsFor(path)),
        });
      } catch (err2) {
        throw SidecarClient.enrich(err2, init.method ?? "GET", path, this);
      }
    }
  }

  /** Wrap a raw fetch error with method, path, target, and cause. */
  private static enrich(
    err: unknown,
    method: string,
    path: string,
    client: SidecarClient,
  ): Error {
    const cause = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && "code" in err
        ? ` (${(err as { code?: string }).code})`
        : "";
    return new Error(
      `${method} ${path} failed: sidecar at ${client.target()} unreachable — ${cause}${code}`,
    );
  }

  /**
   * Update the port file if the sidecar reports a different HTTP port.
   * Best-effort — never throws.
   */
  private static syncPortFile(httpPort?: number | null): void {
    if (typeof httpPort !== "number" || httpPort <= 0) return;
    try {
      const portPath = getSidecarPortPath();
      let filePort: number | null = null;
      if (existsSync(portPath)) {
        const content = readFileSync(portPath, "utf-8").trim();
        filePort = parseInt(content, 10);
        if (Number.isNaN(filePort)) filePort = null;
      }
      if (filePort !== httpPort) {
        writeFileSync(portPath, String(httpPort), "utf-8");
      }
    } catch {
      /* non-fatal */
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /* eslint-disable @typescript-eslint/no-explicit-any */
  protected async get(path: string): Promise<any> {
    const res = await this.fetchWithReconnect(path, {
      method: "GET",
      signal: AbortSignal.timeout(requestTimeoutMsFor(path)),
    });
    const body = (await res.json()) as {
      ok: boolean;
      data?: any;
      error?: string;
    };
    if (!body.ok) throw new Error(body.error ?? "Sidecar request failed");
    return body.data;
  }

  protected async post(path: string, data: unknown): Promise<any> {
    const res = await this.fetchWithReconnect(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(requestTimeoutMsFor(path)),
    });
    const body = (await res.json()) as {
      ok: boolean;
      data?: any;
      error?: string;
    };
    if (!body.ok) throw new Error(body.error ?? "Sidecar request failed");
    return body.data;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Try sidecar first, fall back to direct function if sidecar unavailable.
 * This is the primary pattern used by hooks.
 */
export async function withSidecarOrDirect<T>(
  sidecarFn: (client: SidecarClient) => Promise<T>,
  directFn: () => T | Promise<T>,
): Promise<T> {
  try {
    const client = await SidecarClient.connect();
    if (client) return await sidecarFn(client);
  } catch {
    /* sidecar failed, fall back */
  }
  return directFn();
}
