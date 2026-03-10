/**
 * Sidecar Client
 *
 * Connects to the sidecar server via Unix socket (preferred) or HTTP fallback.
 * Used by hooks, MCP server, and OpenCode plugin to avoid per-invocation
 * MemoryStore cold starts.
 */

import { existsSync, readFileSync } from "node:fs";
import { getSidecarSocketPath, getSidecarPortPath } from "./paths.js";

export class SidecarClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly fetchOpts: RequestInit & { unix?: string },
  ) {}

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
      const client = new SidecarClient("http://localhost", { unix: socketPath });
      try {
        await client.health();
        return client;
      } catch { /* socket exists but not responding */ }
    }

    // Try HTTP port file
    const portPath = getSidecarPortPath();
    if (existsSync(portPath)) {
      try {
        const content = readFileSync(portPath, "utf-8").trim();
        if (content === "unix") return null; // socket mode but socket failed
        const port = parseInt(content, 10);
        if (Number.isNaN(port)) return null;
        const client = new SidecarClient(`http://127.0.0.1:${port}`, {});
        await client.health();
        return client;
      } catch { /* port file exists but server not responding */ }
    }

    return null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, this.fetchOpts);
    const body = await res.json() as { ok: boolean; data?: any; error?: string };
    if (!body.ok) throw new Error(body.error ?? "Sidecar request failed");
    return body.data;
  }

  private async post(path: string, data: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...this.fetchOpts,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json() as { ok: boolean; data?: any; error?: string };
    if (!body.ok) throw new Error(body.error ?? "Sidecar request failed");
    return body.data;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ─── Health ────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string; pid: number }> {
    return this.get("/health");
  }

  // ─── Sessions ──────────────────────────────────────────────────────────

  async createSession(opts: {
    id: string;
    projectPath: string;
    assistant: string;
    transcriptPath?: string | null;
  }): Promise<{ id: string }> {
    return this.post("/session", opts);
  }

  async endSession(id: string, opts: { summary?: string; notification?: boolean } = {}): Promise<void> {
    await this.post(`/session/${id}/end`, opts);
  }

  async getActiveSessions(): Promise<Array<{ id: string; projectPath: string; assistant: string }>> {
    return this.get("/session/active");
  }

  // ─── TDD State ─────────────────────────────────────────────────────────

  async getTddState(filePath: string, projectPath?: string): Promise<{ state: string; hasActiveSpec: boolean }> {
    const params = new URLSearchParams({ file: filePath });
    if (projectPath) params.set("project", projectPath);
    return this.get(`/tdd-state?${params}`);
  }

  async setTddState(opts: {
    filePath: string;
    state: string;
    specId?: string;
    taskPosition?: number;
    testFilePath?: string;
    lastFailOutput?: string;
  }): Promise<void> {
    await this.post("/tdd-state", { action: "set", ...opts });
  }

  async clearTddState(filePath: string): Promise<void> {
    await this.post("/tdd-state", { action: "clear", filePath });
  }

  // ─── Memory ────────────────────────────────────────────────────────────

  async addObservation(obs: {
    sessionId: string;
    projectPath: string;
    type: string;
    title: string;
    content: string;
    filePaths?: string[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: number }> {
    return this.post("/observation", obs);
  }

  async restoreContext(projectPath: string): Promise<{ hasMemory: boolean; markdown: string | null }> {
    return this.get(`/context?project=${encodeURIComponent(projectPath)}`);
  }

  // ─── Memory Search/Timeline/Get/Stats (MCP delegation) ─────────────────

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async memorySearch(opts: {
    query: string;
    project?: string;
    type?: string;
    limit?: number;
  }): Promise<any[]> {
    return this.post("/memory/search", opts);
  }

  async memoryTimeline(opts: {
    anchor: number;
    depth?: number;
    project?: string;
  }): Promise<any> {
    return this.post("/memory/timeline", opts);
  }

  async memoryGet(ids: number[]): Promise<any[]> {
    return this.post("/memory/get", { ids });
  }

  async memoryStats(): Promise<any> {
    return this.get("/memory/stats");
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ─── Specs ─────────────────────────────────────────────────────────────

  async syncSpec(planPath: string, projectPath: string): Promise<void> {
    await this.post("/spec/sync", { planPath, projectPath });
  }

  async getCurrentSpec(projectPath: string): Promise<{ id: string; title: string; status: string } | null> {
    return this.get(`/spec/current?project=${encodeURIComponent(projectPath)}`);
  }

  // ─── Notifications ─────────────────────────────────────────────────────

  async insertNotification(notif: {
    type: string;
    title: string;
    message?: string;
    source?: string;
    specId?: string;
    sessionId?: string;
  }): Promise<void> {
    await this.post("/notification", notif);
  }
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
  } catch { /* sidecar failed, fall back */ }
  return directFn();
}
