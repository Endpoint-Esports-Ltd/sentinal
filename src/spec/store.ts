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
import type { Spec, SpecTask } from "./types.js";

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
      "INSERT INTO spec_tasks (spec_id, position, title, status) VALUES (?, ?, ?, ?)",
    );

    for (const task of spec.tasks) {
      insertTask.run(spec.id, task.position, task.title, task.status);
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

  // --- Helpers ---

  private getTasksForSpec(specId: string): SpecTask[] {
    const rows = this.db
      .prepare("SELECT * FROM spec_tasks WHERE spec_id = ? ORDER BY position")
      .all(specId) as RawSpecTask[];
    return rows.map((r) => ({
      position: r.position,
      title: r.title,
      status: r.status as SpecTask["status"],
    }));
  }

  private deserializeSpec(row: RawSpec): Spec {
    const tasks = this.getTasksForSpec(row.id);
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
