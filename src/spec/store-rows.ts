/**
 * Spec Store — raw row shapes, deserializers and timing reads.
 *
 * Split out of `store.ts` for length. `SpecStore` keeps every public method;
 * these are the pure row → domain mappings and the timing queries it
 * delegates to, taking the resolved key and the raw database.
 */

import type { Database } from "bun:sqlite";
import type { Spec, SpecTask } from "./types.js";

// --- Raw DB Row Types ---

export interface RawSpec {
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

export interface RawSpecTask {
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

export interface SpecTiming {
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface TaskTiming {
  position: number;
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}

// --- Deserializers ---

export function deserializeTaskRow(r: RawSpecTask): SpecTask {
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

/** Map a `specs` row plus its already-loaded tasks to a `Spec`. */
export function deserializeSpecRow(row: RawSpec, tasks: SpecTask[]): Spec {
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

// --- Timing reads ---

/** Spec-level timing for a resolved key (`null` key → no row). */
export function querySpecTiming(
  db: Database,
  key: string | null,
): SpecTiming | null {
  const row = db
    .prepare(
      "SELECT title, status, started_at, completed_at FROM specs WHERE id = ?",
    )
    .get(key) as
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

/** Task-level timing for a resolved key, ordered by position. */
export function queryTaskTiming(
  db: Database,
  key: string | null,
): TaskTiming[] {
  const rows = db
    .prepare(
      "SELECT position, title, status, started_at, completed_at FROM spec_tasks WHERE spec_id = ? ORDER BY position",
    )
    .all(key) as Array<{
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
