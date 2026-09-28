/**
 * Sidecar Client — route methods, base layer (transport, health, sessions,
 * config, TDD).
 *
 * `SidecarRoutes` (`client-routes.ts`) is an abstract-class chain split
 * purely for file length: base → memory → spec → worktree/notification/
 * quality. `SidecarClient` extends the top of the chain, so callers still see
 * a single class with every method on it.
 *
 * ⛔ Must never become reachable to `bun:sqlite` — hooks import the client
 * and must not pay SQLite's cold-start cost. Every import below is
 * `import type` (erased at runtime) for exactly that reason.
 */

import type { TddCycle } from "../memory/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export abstract class SidecarRoutesBase {
  // ─── Transport (implemented by SidecarClient) ──────────────────────────

  protected abstract get(path: string): Promise<any>;
  protected abstract post(path: string, data: unknown): Promise<any>;

  // ─── Health ────────────────────────────────────────────────────────────

  async health(): Promise<{
    status: string;
    pid: number;
    httpPort?: number | null;
    /** Sidecar's sentinal version (M2c). Absent on pre-M2c sidecars. */
    version?: string;
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
    /**
     * Owning project, normalized sidecar-side. Required by v1.40+ sidecars:
     * omitting it is a 400 (D4). Optional here only so the type matches the
     * other actions' body.
     */
    projectPath?: string;
  }): Promise<void> {
    await this.post("/tdd-state", { action: "set", ...opts });
  }

  async clearTddState(filePath: string): Promise<void> {
    await this.post("/tdd-state", { action: "clear", filePath });
  }

  async clearTddStatesForSpec(specId: string): Promise<void> {
    await this.post("/tdd-state", { action: "clearForSpec", specId });
  }

  /** `project` (optional) scopes server-side; an old sidecar ignores it. */
  async listActiveTddStates(
    specId?: string | null,
    project?: string,
  ): Promise<TddCycle[]> {
    const params = new URLSearchParams();
    if (specId) params.set("spec_id", specId);
    if (project) params.set("project", project);
    const qs = params.toString();
    return this.get(`/tdd-state/list${qs ? `?${qs}` : ""}`);
  }

  // ─── TDD Bulk Transition ────────────────────────────────────────────────

  /**
   * Bulk TDD transition, scoped to ONE project. `projectPath` is REQUIRED:
   * the sidecar answers a missing/blank project with a 400 rather than
   * sweeping every project's rows (D6 — destructive writes fail closed).
   */
  async tddTransition(
    action: "confirm_red" | "confirm_green",
    specId: string | undefined,
    projectPath: string,
    /** D1 — tests the run covered; absent/empty = project-wide. Old sidecars ignore it. */
    scope?: { testFiles?: string[]; testDirs?: string[] },
  ): Promise<{ count: number }> {
    return this.post("/tdd-state/transition", {
      action,
      specId,
      projectPath,
      ...(scope?.testFiles?.length ? { testFiles: scope.testFiles } : {}),
      ...(scope?.testDirs?.length ? { testDirs: scope.testDirs } : {}),
    });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
