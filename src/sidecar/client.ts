/**
 * Sidecar Client
 *
 * Connects to the sidecar server via Unix socket (preferred) or HTTP fallback.
 * Used by hooks, MCP server, and OpenCode plugin to avoid per-invocation
 * MemoryStore cold starts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getSidecarSocketPath, getSidecarPortPath } from "./paths.js";
import type { QualityCheckResult } from "./quality-routes.js";
export type { QualityCheckResult } from "./quality-routes.js";
import type { Spec } from "../spec/types.js";
import type { TddCycle, SpecEvent } from "../memory/types.js";
import type { Worktree } from "../worktree/types.js";

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
      const client = new SidecarClient("http://localhost", {
        unix: socketPath,
      });
      try {
        const health = await client.health();

        // Self-heal: sync the HTTP port file from the health response
        // so Node.js clients (which can't use Unix sockets) find the right port
        SidecarClient.syncPortFile(health.httpPort);

        return client;
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
        const client = new SidecarClient(`http://127.0.0.1:${port}`, {});
        await client.health();
        return client;
      } catch {
        /* port file exists but server not responding */
      }
    }

    return null;
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
  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, this.fetchOpts);
    const body = (await res.json()) as {
      ok: boolean;
      data?: any;
      error?: string;
    };
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
    const body = (await res.json()) as {
      ok: boolean;
      data?: any;
      error?: string;
    };
    if (!body.ok) throw new Error(body.error ?? "Sidecar request failed");
    return body.data;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ─── Health ────────────────────────────────────────────────────────────

  async health(): Promise<{
    status: string;
    pid: number;
    httpPort?: number | null;
  }> {
    return this.get("/health");
  }

  /**
   * Lightweight keep-alive ping. Preferred over health() — /ping returns
   * minimal JSON without full status serialization overhead.
   */
  async ping(): Promise<void> {
    await this.get("/ping");
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

  async endSession(
    id: string,
    opts: { summary?: string; notification?: boolean } = {},
  ): Promise<void> {
    await this.post(`/session/${id}/end`, opts);
  }

  async getActiveSessions(): Promise<
    Array<{ id: string; projectPath: string; assistant: string }>
  > {
    return this.get("/session/active");
  }

  // ─── Config ────────────────────────────────────────────────────────────

  async getModelRouting(): Promise<{
    planning: string;
    implementation: string;
    verification: string;
    plan_reviewer: string;
    spec_reviewer: string;
  }> {
    return this.get("/config/model-routing");
  }

  // ─── TDD State ─────────────────────────────────────────────────────────

  async getTddState(
    filePath: string,
    projectPath?: string,
  ): Promise<{ state: string; hasActiveSpec: boolean }> {
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

  async clearTddStatesForSpec(specId: string): Promise<void> {
    await this.post("/tdd-state", { action: "clearForSpec", specId });
  }

  async listActiveTddStates(specId?: string | null): Promise<TddCycle[]> {
    const params = new URLSearchParams();
    if (specId) params.set("spec_id", specId);
    const qs = params.toString();
    return this.get(`/tdd-state/list${qs ? `?${qs}` : ""}`);
  }

  // ─── TDD Bulk Transition ────────────────────────────────────────────────

  async tddTransition(
    action: "confirm_red" | "confirm_green",
    specId?: string,
  ): Promise<{ count: number }> {
    return this.post("/tdd-state/transition", { action, specId });
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

  async restoreContext(
    projectPath: string,
    semanticQuery?: string,
  ): Promise<{ hasMemory: boolean; markdown: string | null }> {
    let url = `/context?project=${encodeURIComponent(projectPath)}`;
    if (semanticQuery)
      url += `&semanticQuery=${encodeURIComponent(semanticQuery)}`;
    return this.get(url);
  }

  // ─── Project Context ────────────────────────────────────────────────────

  async projectContext(
    projectPath: string,
    refresh?: boolean,
  ): Promise<Record<string, unknown>> {
    let url = `/project-context?project=${encodeURIComponent(projectPath)}`;
    if (refresh) url += "&refresh=true";
    return this.get(url);
  }

  /**
   * Invalidate the project-context cache for a specific project path.
   * Best-effort — never throws. The sidecar will clear the cached context
   * so the next /project-context request re-analyzes from disk.
   */
  async invalidateProjectContext(projectPath: string): Promise<void> {
    await this.post("/project-context/invalidate", { project: projectPath });
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

  async getCurrentSpec(projectPath: string): Promise<Spec | null> {
    return this.get(`/spec/current?project=${encodeURIComponent(projectPath)}`);
  }

  async getSpecEvents(specId: string, limit?: number): Promise<SpecEvent[]> {
    const params = new URLSearchParams({ spec_id: specId });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.get(`/spec/events?${params}`);
  }

  // ─── Worktrees ────────────────────────────────────────────────────────

  async resolveWorktreeBySlug(
    slug: string,
    project?: string,
  ): Promise<Worktree | null> {
    const params = new URLSearchParams({ slug });
    if (project) params.set("project", project);
    return this.get(`/worktree/resolve?${params}`);
  }

  async abandonWorktree(worktreeId: string): Promise<void> {
    await this.post("/worktree/abandon", { worktree_id: worktreeId });
  }

  async cleanupWorktrees(projectPath?: string): Promise<{ cleaned: number }> {
    return this.post("/worktree/cleanup", { project: projectPath });
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

  // ─── Quality Checks ──────────────────────────────────────────────────

  async qualityCheck(opts: {
    projectPath: string;
    filePath?: string;
    checks?: string[];
    timeout?: number;
  }): Promise<QualityCheckResult> {
    return this.post("/quality-check", opts);
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
  } catch {
    /* sidecar failed, fall back */
  }
  return directFn();
}
