/**
 * Spec Store
 *
 * SQLite persistence layer for spec/plan tracking.
 * Wraps MemoryStore's raw database to access the specs and spec_tasks tables.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { MemoryStore } from "../memory/store.js";
import { ACTIVE_STATUSES } from "./types.js";
import { canonicalProjectKey } from "../sidecar/project-key.js";
import { resolveSpecKey } from "../memory/spec-key.js";
import type { Spec, SpecTask } from "./types.js";
import { auditSpecCompletion, type AuditResult } from "./audit.js";
import {
  deserializeSpecRow,
  deserializeTaskRow,
  querySpecTiming,
  queryTaskTiming,
  type RawSpec,
  type RawSpecTask,
  type SpecTiming,
  type TaskTiming,
} from "./store-rows.js";
import { healSameIdentityRows, syncPlanCanonical } from "./store-sync.js";

export type { AuditFix, AuditResult } from "./audit.js";

// --- Store ---

export class SpecStore {
  private db: Database;
  private memoryStore: MemoryStore;

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getRawDb();
    this.memoryStore = memoryStore;
  }

  /**
   * Sync a single plan file into the SQLite index — the single write point
   * for `specs.project_path`, so it canonicalizes (idempotently) itself: a raw
   * subdirectory / symlink / `/var` alias key made the Stop guard read the
   * plan as ownerless ("orphaned" block).
   */
  syncFromPlanFile(
    planFile: string,
    projectPath: string,
    sessionId?: string,
  ): Spec {
    return this.syncCanonical(
      planFile,
      canonicalProjectKey(projectPath),
      sessionId,
    );
  }

  /** `syncFromPlanFile` with an already-canonical key (see `store-sync.ts`). */
  private syncCanonical(
    planFile: string,
    projectPath: string,
    sessionId?: string,
  ): Spec {
    return syncPlanCanonical(
      this.db,
      this.memoryStore,
      planFile,
      projectPath,
      sessionId,
    );
  }

  /** Runtime heal (D6) — see `healSameIdentityRows` in `store-sync.ts`. */
  private healSameIdentityRows(key: string, project: string, slug: string) {
    healSameIdentityRows(this.db, key, project, slug);
  }

  /** Resolve a key or slug (optionally within a project) to the stored id. */
  private keyOf(value: string, project?: string): string | null {
    return resolveSpecKey(
      this.db,
      value,
      project ? canonicalProjectKey(project) : undefined,
    );
  }

  /** Get spec-level timing data (key, or slug + optional project). */
  getSpecTiming(specId: string, project?: string): SpecTiming | null {
    return querySpecTiming(this.db, this.keyOf(specId, project));
  }

  /** Get task-level timing data (key, or slug + optional project). */
  getTaskTiming(specId: string, project?: string): TaskTiming[] {
    return queryTaskTiming(this.db, this.keyOf(specId, project));
  }

  /** Sync all plan files from a directory into the SQLite index. */
  syncAllPlans(plansDir: string, projectPath: string): number {
    let count = 0;
    // Resolve the identity ONCE per call, not one git spawn per plan file.
    const key = canonicalProjectKey(projectPath);
    try {
      const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        this.syncCanonical(join(plansDir, file), key);
        count++;
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
    return count;
  }

  /**
   * Get a spec by its key, or by slug (within `project` when given). A bare
   * slug that exists in more than one project resolves to null — pass the
   * project (D6).
   */
  getSpec(id: string, project?: string): Spec | null {
    const key = this.keyOf(id, project);
    if (!key) return null;
    const row = this.db
      .prepare("SELECT * FROM specs WHERE id = ?")
      .get(key) as RawSpec | null;
    if (!row) return null;
    return this.deserializeSpec(row);
  }

  /** List all specs for a project (key canonicalized), most recent first. */
  listSpecs(projectPath: string): Spec[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM specs WHERE project_path = ? ORDER BY updated_at DESC",
      )
      .all(canonicalProjectKey(projectPath)) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /** List all specs across all projects, ordered by most recent first. */
  listAllSpecs(limit: number = 100): Spec[] {
    const rows = this.db
      .prepare("SELECT * FROM specs ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /**
   * Get the current (most recently updated) active spec for a project. The
   * key is canonicalized like the write point, so a raw alias still matches.
   */
  getCurrentSpec(projectPath: string): Spec | null {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const params: SQLQueryBindings[] = [
      canonicalProjectKey(projectPath),
      ...(ACTIVE_STATUSES as readonly string[]),
    ];
    const row = this.db
      .prepare(
        `SELECT * FROM specs WHERE project_path = ? AND status IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(...params) as RawSpec | null;
    if (!row) return null;
    return this.deserializeSpec(row);
  }

  /** Get all specs associated with a session. */
  getSpecsForSession(sessionId: string): Spec[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM specs WHERE session_id = ? ORDER BY updated_at DESC",
      )
      .all(sessionId) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /**
   * Is a plan with this slug IN_PROGRESS in ANY project? The guard that keeps
   * a running plan's worktree from being force-removed. Deliberately
   * project-blind (D6): a bare slug may name plans in several projects, and a
   * false positive only skips one removal, while a false negative deletes work.
   */
  isSlugInProgress(slug: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM specs WHERE (slug = ? OR id = ?) AND status = 'IN_PROGRESS' LIMIT 1",
        )
        .get(slug, slug) !== null
    );
  }

  /** Get a spec by ID with tasks pre-loaded (convenience wrapper). */
  getSpecWithTasks(specId: string, project?: string): Spec | null {
    return this.getSpec(specId, project);
  }

  /**
   * Get the current task being worked on for a spec.
   * Returns the first "in-progress" task, or the first "pending" task if none in-progress.
   * Returns null if all tasks are complete/failed or the spec has no tasks.
   */
  getCurrentTask(specId: string, project?: string): SpecTask | null {
    const key = this.keyOf(specId, project);
    if (!key) return null;
    // Prefer in-progress
    const inProgress = this.db
      .prepare(
        "SELECT * FROM spec_tasks WHERE spec_id = ? AND status = 'in-progress' ORDER BY position LIMIT 1",
      )
      .get(key) as RawSpecTask | null;
    if (inProgress) return this.deserializeTask(inProgress);

    // Fall back to first pending
    const pending = this.db
      .prepare(
        "SELECT * FROM spec_tasks WHERE spec_id = ? AND status = 'pending' ORDER BY position LIMIT 1",
      )
      .get(key) as RawSpecTask | null;
    if (pending) return this.deserializeTask(pending);

    return null;
  }

  /**
   * Update a task's status (and optional timestamps).
   */
  updateTaskStatus(
    specId: string,
    position: number,
    status: SpecTask["status"],
    opts?: { startedAt?: number; completedAt?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE spec_tasks
         SET status = ?, started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at)
         WHERE spec_id = ? AND position = ?`,
      )
      .run(
        status,
        opts?.startedAt ?? null,
        opts?.completedAt ?? null,
        this.keyOf(specId) ?? specId,
        position,
      );
  }

  /**
   * Cross-check plan file checkboxes against SQLite task states, fixing
   * discrepancies in both directions (see `audit.ts`).
   */
  auditCompletion(specId: string): AuditResult {
    return auditSpecCompletion(this, specId);
  }

  // --- Helpers ---

  /** Get all tasks for a spec, ordered by position. */
  getTasksForSpec(specId: string): SpecTask[] {
    const rows = this.db
      .prepare("SELECT * FROM spec_tasks WHERE spec_id = ? ORDER BY position")
      .all(this.keyOf(specId) ?? specId) as RawSpecTask[];
    return rows.map((r) => this.deserializeTask(r));
  }

  private deserializeTask(r: RawSpecTask): SpecTask {
    return deserializeTaskRow(r);
  }

  private deserializeSpec(row: RawSpec): Spec {
    return deserializeSpecRow(row, this.getTasksForSpec(row.id) as SpecTask[]);
  }
}
