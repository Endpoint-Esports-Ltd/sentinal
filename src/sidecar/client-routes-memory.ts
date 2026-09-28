/**
 * Sidecar Client — route methods, memory layer (observations, context
 * restore, project context, MCP memory delegation).
 *
 * One link of the `SidecarRoutes` chain (see `client-routes-base.ts`).
 *
 * ⛔ Must never become reachable to `bun:sqlite`: the only runtime import is
 * the previous link of the chain.
 */

import { SidecarRoutesBase } from "./client-routes-base.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export abstract class SidecarRoutesMemory extends SidecarRoutesBase {
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
    /** D8 — local checkout for shared memory; old sidecars ignore it. */
    workspace?: string,
  ): Promise<{ hasMemory: boolean; markdown: string | null }> {
    let url = `/context?project=${encodeURIComponent(projectPath)}`;
    if (semanticQuery)
      url += `&semanticQuery=${encodeURIComponent(semanticQuery)}`;
    if (workspace) url += `&workspace=${encodeURIComponent(workspace)}`;
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
}
/* eslint-enable @typescript-eslint/no-explicit-any */
