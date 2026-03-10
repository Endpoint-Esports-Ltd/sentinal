/**
 * Spec Store
 *
 * SQLite persistence layer for spec/plan tracking.
 * Wraps MemoryStore's raw database to access the specs and spec_tasks tables.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { MemoryStore } from "../memory/store.js";
import { parsePlanFile } from "./parser.js";
import { ACTIVE_STATUSES } from "./types.js";
import type { Spec, SpecTask } from "./types.js";

// --- Audit Types ---

export interface AuditFix {
  taskPosition: number;
  taskTitle: string;
  issue: "md-ahead" | "sqlite-ahead";
  /** What was changed: "updated-sqlite" or "updated-md" */
  action: string;
}

export interface AuditResult {
  specId: string;
  totalTasks: number;
  completeTasks: number;
  fixes: AuditFix[];
  inSync: boolean;
}

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

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getRawDb();
  }

  /** Sync a single plan file into the SQLite index. */
  syncFromPlanFile(planFile: string, projectPath: string, sessionId?: string): Spec {
    const spec = parsePlanFile(planFile);
    const now = Date.now();
    const tasksDone = spec.tasks.filter((t) => t.status === "complete").length;
    const metadataJson = JSON.stringify(spec.metadata ?? {});

    const upsertSpec = this.db.prepare(
      `INSERT OR REPLACE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at, session_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    upsertSpec.run(
      spec.id, projectPath, spec.title, spec.id, spec.type, spec.status,
      spec.approved ? 1 : 0, planFile, spec.tasks.length, tasksDone, now, now,
      sessionId ?? null, metadataJson,
    );

    // Sync tasks — delete existing then re-insert
    this.db.prepare("DELETE FROM spec_tasks WHERE spec_id = ?").run(spec.id);
    const insertTask = this.db.prepare(
      `INSERT INTO spec_tasks (spec_id, position, title, status, description, test_strategy, definition_of_done)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const task of spec.tasks) {
      insertTask.run(
        spec.id,
        task.position,
        task.title,
        task.status,
        task.description ?? null,
        task.testStrategy ?? null,
        task.definitionOfDone ?? null,
      );
    }

    return spec;
  }

  /** Sync all plan files from a directory into the SQLite index. */
  syncAllPlans(plansDir: string, projectPath: string): number {
    let count = 0;
    try {
      const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        this.syncFromPlanFile(join(plansDir, file), projectPath);
        count++;
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
    return count;
  }

  /** Get a spec by ID (slug). */
  getSpec(id: string): Spec | null {
    const row = this.db
      .prepare("SELECT * FROM specs WHERE id = ?")
      .get(id) as RawSpec | null;
    if (!row) return null;
    return this.deserializeSpec(row);
  }

  /** List all specs for a project, ordered by most recent first. */
  listSpecs(projectPath: string): Spec[] {
    const rows = this.db
      .prepare("SELECT * FROM specs WHERE project_path = ? ORDER BY updated_at DESC")
      .all(projectPath) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /** List all specs across all projects, ordered by most recent first. */
  listAllSpecs(limit: number = 100): Spec[] {
    const rows = this.db
      .prepare("SELECT * FROM specs ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /** Get the current (most recently updated) active spec for a project. */
  getCurrentSpec(projectPath: string): Spec | null {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const params: SQLQueryBindings[] = [projectPath, ...(ACTIVE_STATUSES as readonly string[])];
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
      .prepare("SELECT * FROM specs WHERE session_id = ? ORDER BY updated_at DESC")
      .all(sessionId) as RawSpec[];
    return rows.map((r) => this.deserializeSpec(r));
  }

  /** Get a spec by ID with tasks pre-loaded (convenience wrapper). */
  getSpecWithTasks(specId: string): Spec | null {
    return this.getSpec(specId);
  }

  /**
   * Get the current task being worked on for a spec.
   * Returns the first "in-progress" task, or the first "pending" task if none in-progress.
   * Returns null if all tasks are complete/failed or the spec has no tasks.
   */
  getCurrentTask(specId: string): SpecTask | null {
    // Prefer in-progress
    const inProgress = this.db
      .prepare(
        "SELECT * FROM spec_tasks WHERE spec_id = ? AND status = 'in-progress' ORDER BY position LIMIT 1",
      )
      .get(specId) as RawSpecTask | null;
    if (inProgress) return this.deserializeTask(inProgress);

    // Fall back to first pending
    const pending = this.db
      .prepare(
        "SELECT * FROM spec_tasks WHERE spec_id = ? AND status = 'pending' ORDER BY position LIMIT 1",
      )
      .get(specId) as RawSpecTask | null;
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
      .run(status, opts?.startedAt ?? null, opts?.completedAt ?? null, specId, position);
  }

  /**
   * Cross-check plan file checkboxes against SQLite task states.
   * Fixes discrepancies in both directions:
   *   - md has [x] but sqlite has pending/in-progress → update sqlite to complete
   *   - sqlite has complete but md has [ ] → update md checkbox to [x]
   */
  auditCompletion(specId: string): AuditResult {
    const spec = this.getSpec(specId);
    if (!spec) {
      return { specId, totalTasks: 0, completeTasks: 0, fixes: [], inSync: true };
    }

    // Re-parse the .md file to get current checkbox states
    const mdSpec = parsePlanFile(spec.planFile);
    const sqliteTasks = this.getTasksForSpec(specId);
    const fixes: AuditFix[] = [];

    // Build a map of sqlite tasks by position
    const sqliteByPos = new Map(sqliteTasks.map((t) => [t.position, t]));

    for (const mdTask of mdSpec.tasks) {
      const sqliteTask = sqliteByPos.get(mdTask.position);
      if (!sqliteTask) continue;

      const mdComplete = mdTask.status === "complete";
      const sqliteComplete = sqliteTask.status === "complete";

      if (mdComplete && !sqliteComplete) {
        // MD is ahead — update SQLite
        this.updateTaskStatus(specId, mdTask.position, "complete", { completedAt: Date.now() });
        fixes.push({
          taskPosition: mdTask.position,
          taskTitle: mdTask.title,
          issue: "md-ahead",
          action: "updated-sqlite",
        });
      } else if (sqliteComplete && !mdComplete) {
        // SQLite is ahead — update MD file
        fixes.push({
          taskPosition: mdTask.position,
          taskTitle: sqliteTask.title,
          issue: "sqlite-ahead",
          action: "updated-md",
        });
      }
    }

    // If any sqlite-ahead fixes, rewrite the md file
    const sqliteAheadPositions = new Set(
      fixes.filter((f) => f.issue === "sqlite-ahead").map((f) => f.taskPosition),
    );
    if (sqliteAheadPositions.size > 0) {
      this.updateMdCheckboxes(spec.planFile, sqliteAheadPositions);
    }

    const finalTasks = this.getTasksForSpec(specId);
    const completeTasks = finalTasks.filter((t) => t.status === "complete").length;

    return {
      specId,
      totalTasks: finalTasks.length,
      completeTasks,
      fixes,
      inSync: fixes.length === 0,
    };
  }

  // --- Helpers ---

  /** Get all tasks for a spec, ordered by position. */
  getTasksForSpec(specId: string): SpecTask[] {
    const rows = this.db
      .prepare("SELECT * FROM spec_tasks WHERE spec_id = ? ORDER BY position")
      .all(specId) as RawSpecTask[];
    return rows.map((r) => this.deserializeTask(r));
  }

  /**
   * Rewrite a plan file's checkboxes: change `- [ ] Task N:` to `- [x] Task N:`
   * for the given task positions. Preserves all other content.
   */
  private updateMdCheckboxes(planFile: string, positions: Set<number>): void {
    const content = readFileSync(planFile, "utf-8");
    const lines = content.split("\n");

    const updated = lines.map((line) => {
      // Match: `- [ ] Task N: Title` or `- [~] Task N: Title`
      const match = line.match(/^(-\s+)\[[ ~]\]\s+(Task\s+(\d+):.*)$/i);
      if (match) {
        const pos = parseInt(match[3], 10);
        if (positions.has(pos)) {
          return `${match[1]}[x] ${match[2]}`;
        }
      }
      return line;
    });

    writeFileSync(planFile, updated.join("\n"));
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
      id: row.id,
      title: row.title,
      status: row.status as Spec["status"],
      type: row.type as Spec["type"],
      approved: row.approved === 1,
      planFile: row.plan_file,
      sessionId: row.session_id ?? undefined,
      tasks,
      metadata,
    };
  }
}
