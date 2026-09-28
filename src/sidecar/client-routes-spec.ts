/**
 * Sidecar Client — route methods, spec layer (sync, current spec, events,
 * metrics).
 *
 * One link of the `SidecarRoutes` chain (see `client-routes-base.ts`).
 *
 * ⛔ Must never become reachable to `bun:sqlite`: the only runtime import is
 * the previous link of the chain; everything else is `import type`.
 */

import { SidecarRoutesMemory } from "./client-routes-memory.js";
import type { SpecMetricsData } from "./spec-routes.js";
import type { Spec } from "../spec/types.js";
import type { SpecEvent } from "../memory/types.js";

export abstract class SidecarRoutesSpec extends SidecarRoutesMemory {
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
  async getSpecMetrics(
    specId: string,
    /** D6 — disambiguates a shared slug; old sidecars ignore it. */
    project?: string,
  ): Promise<SpecMetricsData> {
    let url = `/spec/metrics?spec_id=${encodeURIComponent(specId)}`;
    if (project) url += `&project=${encodeURIComponent(project)}`;
    return this.get(url);
  }
}
