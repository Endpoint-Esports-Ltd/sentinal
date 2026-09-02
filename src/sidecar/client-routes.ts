/**
 * Sidecar Client — route methods
 *
 * The one-line-per-endpoint half of `SidecarClient`, split out of
 * `client.ts` purely for file length. `SidecarClient` extends this, so
 * callers still see a single class with every method on it.
 *
 * ⛔ Must never become reachable to `bun:sqlite` — hooks import the client
 * and must not pay SQLite's cold-start cost. Every import below is
 * `import type` (erased at runtime) for exactly that reason.
 */

import type { QualityCheckResult } from "./quality-routes.js";
import type { SpecMetricsData } from "./spec-routes.js";
import type { Spec } from "../spec/types.js";
import type { TddCycle, SpecEvent } from "../memory/types.js";
import type { ResolvedWorktree } from "../worktree/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export abstract class SidecarRoutes {
  // ─── Transport (implemented by SidecarClient) ──────────────────────────

  protected abstract get(path: string): Promise<any>;
  protected abstract post(path: string, data: unknown): Promise<any>;

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

  async getCompactionConfig(
    projectPath: string,
  ): Promise<{ reserved: number }> {
    return this.get(
      `/config/compaction?project=${encodeURIComponent(projectPath)}`,
    );
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

  async updateObservation(patch: {
    id: number;
    title?: string;
    content?: string;
    type?: string;
    tags?: string[];
    filePaths?: string[];
  }): Promise<unknown> {
    return this.post("/memory/update", patch);
  }

  async deleteObservation(id: number): Promise<{ deleted: boolean }> {
    return this.post("/memory/delete", { id });
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

  // ─── Specs ─────────────────────────────────────────────────────────────

  async syncSpec(
    planPath: string,
    projectPath: string,
    sessionId?: string,
  ): Promise<void> {
    await this.post("/spec/sync", {
      planPath,
      projectPath,
      sessionId: sessionId ?? null,
    });
  }

  /**
   * Bump the last_active heartbeat for a session.
   * Fire-and-forget — callers should .catch(() => {}) as this is non-critical.
   */
  async touchSession(sessionId: string): Promise<void> {
    await this.post("/session/touch", { sessionId });
  }

  /**
   * Check whether a session is currently alive (store-side isSessionAlive).
   * Lets the OpenCode plugin resolve liveness without importing MemoryStore
   * (which would pull bun:sqlite into the plugin bundle).
   */
  async isSessionAlive(sessionId: string): Promise<boolean> {
    const res = (await this.get(
      `/session/alive?id=${encodeURIComponent(sessionId)}`,
    )) as { alive?: boolean };
    return res?.alive === true;
  }

  async getCurrentSpec(projectPath: string): Promise<Spec | null> {
    return this.get(`/spec/current?project=${encodeURIComponent(projectPath)}`);
  }

  async getSpecEvents(specId: string, limit?: number): Promise<SpecEvent[]> {
    const params = new URLSearchParams({ spec_id: specId });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.get(`/spec/events?${params}`);
  }

  /**
   * Spec + task timing for spec_metrics. One route, one shape — exactly
   * the two store reads the tool performs (getSpecTiming + getTaskTiming).
   */
  async getSpecMetrics(specId: string): Promise<SpecMetricsData> {
    return this.get(`/spec/metrics?spec_id=${encodeURIComponent(specId)}`);
  }

  // ─── Worktrees ────────────────────────────────────────────────────────

  /**
   * Resolve (and reconcile) a worktree by plan slug.
   *
   * The response carries `warnings` — non-fatal seeding/slot problems raised by
   * the sidecar's own `resolveWithReconcile`. Callers that surface output to a
   * human or an LLM MUST forward them: this is the default detect path, and a
   * silently unseeded worktree is what drives an agent to copy the repo-root
   * `.env` in (issue #2).
   */
  async resolveWorktreeBySlug(
    slug: string,
    project?: string,
  ): Promise<ResolvedWorktree | null> {
    const params = new URLSearchParams({ slug });
    if (project) params.set("project", project);
    return this.get(`/worktree/resolve?${params}`);
  }

  async abandonWorktree(worktreeId: string): Promise<void> {
    await this.post("/worktree/abandon", { worktree_id: worktreeId });
  }

  async cleanupWorktrees(
    projectPath?: string,
    opts?: { force?: boolean; currentWorktree?: string },
  ): Promise<{ cleaned: number }> {
    return this.post("/worktree/cleanup", {
      project: projectPath,
      force: opts?.force,
      currentWorktree: opts?.currentWorktree,
    });
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
/* eslint-enable @typescript-eslint/no-explicit-any */
