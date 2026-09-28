/**
 * Sidecar Client — route methods
 *
 * The one-line-per-endpoint half of `SidecarClient`, split out of
 * `client.ts` purely for file length. `SidecarClient` extends this, so
 * callers still see a single class with every method on it.
 *
 * Itself split by domain into an abstract-class chain, again only for length:
 *   `SidecarRoutesBase`   (client-routes-base.ts)   transport, health, sessions, config, TDD
 *   → `SidecarRoutesMemory` (client-routes-memory.ts) memory, project context
 *   → `SidecarRoutesSpec`   (client-routes-spec.ts)   specs
 *   → `SidecarRoutes`       (this file)               worktrees, notifications, retire, quality
 *
 * ⛔ Must never become reachable to `bun:sqlite` — hooks import the client
 * and must not pay SQLite's cold-start cost. The only runtime import is the
 * previous link of the chain; everything else is `import type` (erased at
 * runtime) for exactly that reason.
 */

import { SidecarRoutesSpec } from "./client-routes-spec.js";
import type { QualityCheckResult } from "./quality-routes.js";
import type { Notification } from "../memory/types.js";
import type { ResolvedWorktree } from "../worktree/types.js";

export abstract class SidecarRoutes extends SidecarRoutesSpec {
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

  async abandonWorktree(
    worktreeId: string,
    opts?: { idempotencyKey?: string },
  ): Promise<void> {
    await this.post("/worktree/abandon", {
      worktree_id: worktreeId,
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  /**
   * `removed` is OPTIONAL on the return type by design (issue #9): a NEWER
   * client may be talking to an OLDER sidecar that answers with `cleaned`
   * alone. Callers must treat its absence as an empty list, never as an error.
   */
  async cleanupWorktrees(
    projectPath?: string,
    opts?: {
      force?: boolean;
      currentWorktree?: string;
      idempotencyKey?: string;
    },
  ): Promise<{
    cleaned: number;
    removed?: Array<{
      path: string;
      branch: string;
      slug: string;
      pass: string;
    }>;
    warnings?: string[];
    /** True when the sidecar replayed an earlier identical request. */
    replayed?: boolean;
  }> {
    return this.post("/worktree/cleanup", {
      project: projectPath,
      force: opts?.force,
      currentWorktree: opts?.currentWorktree,
      idempotencyKey: opts?.idempotencyKey,
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
    /** Owning project (D5); omit for a global notification. */
    projectPath?: string;
  }): Promise<void> {
    await this.post("/notification", notif);
  }

  // ─── Retire (D3) ─────────────────────────────────────────────────────

  /**
   * Ask the sidecar to retire when safe (POST /retire). Idempotent and
   * returns immediately — the sidecar owns the "when" (D3) and only stops;
   * it never respawns (D4). `runningVersion` is the SIDECAR's (stale)
   * version, `installedVersion` the newer one this caller runs; the route
   * emits the skew notification only when both are present. A pre-Task-5
   * sidecar has no route and answers 404 (D5) — callers must swallow.
   */
  async requestRetire(
    runningVersion?: string,
    installedVersion?: string,
  ): Promise<void> {
    await this.post("/retire", { runningVersion, installedVersion });
  }

  /**
   * Unread session-start candidates for `projectPath` plus global-source rows
   * (GET /notifications/session). Side-effect free. Old sidecars 404.
   */
  async listSessionNotifications(
    projectPath: string,
    limit: number,
  ): Promise<Notification[]> {
    const params = new URLSearchParams({ project: projectPath });
    params.set("limit", String(limit));
    return this.get(`/notifications/session?${params}`);
  }

  /** Mark ONE notification read. There is deliberately no mark-all. */
  async markNotificationRead(id: number): Promise<void> {
    await this.post("/notifications/read", { id });
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
