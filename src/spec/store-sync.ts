/**
 * Spec Store — plan-file sync (the single write point for `specs`) and the
 * D6 runtime heal.
 *
 * Split out of `store.ts` for length; `SpecStore.syncFromPlanFile` /
 * `syncAllPlans` delegate here with an already-canonical project key.
 */

import type { Database } from "bun:sqlite";
import type { MemoryStore } from "../memory/store.js";
import { parsePlanFile } from "./parser.js";
import { canonicalProjectKey } from "../sidecar/project-key.js";
import {
  mergeSpecInto,
  renameSpec,
  specKey,
  withDeferredFks,
} from "../memory/spec-key.js";
import type { Spec } from "./types.js";

/** `syncFromPlanFile` with an already-canonical key. */
export function syncPlanCanonical(
  db: Database,
  memoryStore: MemoryStore,
  planFile: string,
  projectPath: string,
  sessionId?: string,
): Spec {
  const spec = parsePlanFile(planFile);
  // D6: the stored id is project-qualified; `spec.id` stays the slug.
  const key = specKey(projectPath, spec.id);
  healSameIdentityRows(db, key, projectPath, spec.id);
  const now = Date.now();
  const tasksDone = spec.tasks.filter((t) => t.status === "complete").length;
  const metadataJson = JSON.stringify(spec.metadata ?? {});

  // Fetch existing spec to detect status transitions and preserve timing
  const existingSpec = db
    .prepare("SELECT status, started_at, completed_at FROM specs WHERE id = ?")
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
  if (spec.status === "VERIFIED" && oldStatus !== "VERIFIED" && !completedAt) {
    completedAt = now;
  }

  // Use ON CONFLICT to preserve timing columns and created_at.
  //
  // ⛔ `project_path` IS in the UPDATE set, deliberately. It used to be
  // INSERT-only and therefore sticky forever: a row first written from a
  // linked worktree kept that worktree's path as its key for the rest of
  // time, so the same plan re-registered from the main checkout stayed
  // invisible to `getCurrentSpec(canonicalRoot)`. The key is now the
  // CANONICAL identity (canonicalized by the caller), and writing it on
  // conflict is what lets pre-existing stale rows self-heal on the next
  // `spec_register` — no schema migration, no `SCHEMA_VERSION` bump.
  //
  // `plan_file` stays worktree-LOCAL on purpose: it names a real file in the
  // registering checkout, and every worktree has its own `docs/plans/`.
  const upsertSpec = db.prepare(
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
    memoryStore.logSpecEvent({
      specId: key,
      sessionId: sessionId ?? undefined,
      eventType: "phase_change",
      details: { from: oldStatus, to: spec.status },
    });
  }

  // Sync tasks — use ON CONFLICT to preserve timing columns
  const upsertTask = db.prepare(
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
  db.prepare("DELETE FROM spec_tasks WHERE spec_id = ? AND position > ?").run(
    key,
    spec.tasks.length,
  );

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
export function healSameIdentityRows(
  db: Database,
  key: string,
  project: string,
  slug: string,
): void {
  if (db.prepare("SELECT 1 FROM specs WHERE id = ?").get(key)) return;
  const same = (
    db
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
  withDeferredFks(db, () => {
    const [winner, ...losers] = same;
    for (const l of losers) mergeSpecInto(db, l.id, winner!.id);
    renameSpec(db, winner!.id, key, project);
  });
}
