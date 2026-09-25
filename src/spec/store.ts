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
import { parsePlanFile } from "./parser.js";
import { ACTIVE_STATUSES } from "./types.js";
import { canonicalProjectKey } from "../sidecar/project-key.js";
import {
  mergeSpecInto,
  renameSpec,
  resolveSpecKey,
  specKey,
  withDeferredFks,
} from "../memory/spec-key.js";
import type { Spec, SpecTask } from "./types.js";
import { auditSpecCompletion, type AuditResult } from "./audit.js";

export type { AuditFix, AuditResult } from "./audit.js";

// --- Raw DB Row Types ---

interface RawSpec {
  id: string;
  project_path: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  approved: number;
  plan_file: string;
  task_count: number;
  tasks_done: number;
  created_at: number;
  updated_at: number;
  session_id: string | null;
  metadata: string | null;
  parent: string | null;
  wave: number | null;
  started_at: number | null;
  completed_at: number | null;
}

interface RawSpecTask {
  id: number;
  spec_id: string;
  position: number;
  title: string;
  status: string;
  description: string | null;
  test_strategy: string | null;
  definition_of_done: string | null;
  started_at: number | null;
  completed_at: number | null;
}

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

  /** `syncFromPlanFile` with an already-canonical key. */
  private syncCanonical(
    planFile: string,
    projectPath: string,
    sessionId?: string,
  ): Spec {
    const spec = parsePlanFile(planFile);
    // D6: the stored id is project-qualified; `spec.id` stays the slug.
    const key = specKey(projectPath, spec.id);
    this.healSameIdentityRows(key, projectPath, spec.id);
    const now = Date.now();
    const tasksDone = spec.tasks.filter((t) => t.status === "complete").length;
    const metadataJson = JSON.stringify(spec.metadata ?? {});

    // Fetch existing spec to detect status transitions and preserve timing
    const existingSpec = this.db
      .prepare(
        "SELECT status, started_at, completed_at FROM specs WHERE id = ?",
      )
      .get(key) as
      | {
          status: string;
          started_at: number | null;
          completed_at: number | null;
        }
      | undefined;

    const oldStatus = existingSpec?.status ?? null;

    // Determine timing fields based on status transitions
    let startedAt: number | null = existingSpec?.started_at ?? null;
    let completedAt: number | null = existingSpec?.completed_at ?? null;

    if (
      spec.status === "IN_PROGRESS" &&
      oldStatus !== "IN_PROGRESS" &&
      !startedAt
    ) {
      startedAt = now;
    }
    if (
      spec.status === "VERIFIED" &&
      oldStatus !== "VERIFIED" &&
      !completedAt
    ) {
      completedAt = now;
    }

    // Use ON CONFLICT to preserve timing columns and created_at.
    //
    // ⛔ `project_path` IS in the UPDATE set, deliberately. It used to be
    // INSERT-only and therefore sticky forever: a row first written from a
    // linked worktree kept that worktree's path as its key for the rest of
    // time, so the same plan re-registered from the main checkout stayed
    // invisible to `getCurrentSpec(canonicalRoot)`. The key is now the
    // CANONICAL identity (canonicalized above), and writing it on
    // conflict is what lets pre-existing stale rows self-heal on the next
    // `spec_register` — no schema migration, no `SCHEMA_VERSION` bump.
    //
    // `plan_file` stays worktree-LOCAL on purpose: it names a real file in the
    // registering checkout, and every worktree has its own `docs/plans/`.
    const upsertSpec = this.db.prepare(
      `INSERT INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at, session_id, metadata, parent, wave, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_path = excluded.project_path,
         title = excluded.title,
         type = excluded.type,
         status = excluded.status,
         approved = excluded.approved,
         plan_file = excluded.plan_file,
         task_count = excluded.task_count,
         tasks_done = excluded.tasks_done,
         updated_at = excluded.updated_at,
         session_id = COALESCE(excluded.session_id, specs.session_id),
         metadata = excluded.metadata,
         parent = excluded.parent,
         wave = excluded.wave,
         started_at = COALESCE(excluded.started_at, specs.started_at),
         completed_at = COALESCE(excluded.completed_at, specs.completed_at)`,
    );
    upsertSpec.run(
      key,
      projectPath,
      spec.title,
      spec.id,
      spec.type,
      spec.status,
      spec.approved ? 1 : 0,
      planFile,
      spec.tasks.length,
      tasksDone,
      now,
      now,
      sessionId ?? null,
      metadataJson,
      spec.parent ?? null,
      spec.wave ?? null,
      startedAt,
      completedAt,
    );

    // Log phase_change event on status transitions
    if (oldStatus && oldStatus !== spec.status) {
      this.memoryStore.logSpecEvent({
        specId: key,
        sessionId: sessionId ?? undefined,
        eventType: "phase_change",
        details: { from: oldStatus, to: spec.status },
      });
    }

    // Sync tasks — use ON CONFLICT to preserve timing columns
    const upsertTask = this.db.prepare(
      `INSERT INTO spec_tasks (spec_id, position, title, status, description, test_strategy, definition_of_done)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(spec_id, position) DO UPDATE SET
         title = excluded.title,
         status = excluded.status,
         description = excluded.description,
         test_strategy = excluded.test_strategy,
         definition_of_done = excluded.definition_of_done`,
    );

    // Delete tasks that no longer exist in the plan (position > task count)
    this.db
      .prepare("DELETE FROM spec_tasks WHERE spec_id = ? AND position > ?")
      .run(key, spec.tasks.length);

    for (const task of spec.tasks) {
      upsertTask.run(
        key,
        task.position,
        task.title,
        task.status,
        task.description ?? null,
        task.testStrategy ?? null,
        task.definitionOfDone ?? null,
      );
    }

    return { ...spec, key, projectPath };
  }

  /**
   * Runtime heal (D6). When `key` has no row yet, a row for the same slug
   * whose project resolves to the same identity — a linked-worktree key V14
   * could not see through, or a bare id an old sidecar wrote after V14 — is
   * re-keyed onto `key` (newest wins; the rest are folded in) instead of
   * leaving an orphan duplicate. Only runs on a first registration.
   */
  private healSameIdentityRows(key: string, project: string, slug: string) {
    if (this.db.prepare("SELECT 1 FROM specs WHERE id = ?").get(key)) return;
    const same = (
      this.db
        .prepare(
          "SELECT id, project_path, updated_at FROM specs WHERE slug = ? AND id != ?",
        )
        .all(slug, key) as Array<{
        id: string;
        project_path: string;
        updated_at: number;
      }>
    )
      .filter(
        (r) =>
          r.project_path === project ||
          canonicalProjectKey(r.project_path) === project,
      )
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
    if (same.length === 0) return;
    withDeferredFks(this.db, () => {
      const [winner, ...losers] = same;
      for (const l of losers) mergeSpecInto(this.db, l.id, winner!.id);
      renameSpec(this.db, winner!.id, key, project);
    });
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
  getSpecTiming(
    specId: string,
    project?: string,
  ): {
    title: string;
    status: string;
    startedAt: number | null;
    completedAt: number | null;
  } | null {
    const row = this.db
      .prepare(
        "SELECT title, status, started_at, completed_at FROM specs WHERE id = ?",
      )
      .get(this.keyOf(specId, project)) as
      | {
          title: string;
          status: string;
          started_at: number | null;
          completed_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      title: row.title,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  /** Get task-level timing data (key, or slug + optional project). */
  getTaskTiming(
    specId: string,
    project?: string,
  ): Array<{
    position: number;
    title: string;
    status: string;
    startedAt: number | null;
    completedAt: number | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT position, title, status, started_at, completed_at FROM spec_tasks WHERE spec_id = ? ORDER BY position",
      )
      .all(this.keyOf(specId, project)) as Array<{
      position: number;
      title: string;
      status: string;
      started_at: number | null;
      completed_at: number | null;
    }>;
    return rows.map((r) => ({
      position: r.position,
      title: r.title,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
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
    return {
      position: r.position,
      title: r.title,
      status: r.status as SpecTask["status"],
      ...(r.description && { description: r.description }),
      ...(r.test_strategy && { testStrategy: r.test_strategy }),
      ...(r.definition_of_done && { definitionOfDone: r.definition_of_done }),
      ...(r.started_at && { startedAt: r.started_at }),
      ...(r.completed_at && { completedAt: r.completed_at }),
    };
  }

  private deserializeSpec(row: RawSpec): Spec {
    const tasks = this.getTasksForSpec(row.id) as SpecTask[];
    let metadata: Spec["metadata"] = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      // Malformed JSON — fall back to empty
    }
    return {
      id: row.slug || row.id,
      key: row.id,
      projectPath: row.project_path,
      title: row.title,
      status: row.status as Spec["status"],
      type: row.type as Spec["type"],
      approved: row.approved === 1,
      planFile: row.plan_file,
      sessionId: row.session_id ?? undefined,
      parent: row.parent ?? undefined,
      wave: row.wave ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      tasks,
      metadata,
    };
  }
}
