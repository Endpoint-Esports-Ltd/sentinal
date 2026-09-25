/**
 * Migration V14 — project-qualified `specs.id` (D6).
 *
 * Every spec row is re-keyed to `<canonicalProject>::<slug>`, with all five
 * referencing columns (`spec_tasks`, `spec_events`, `notifications`,
 * `tdd_cycles`, `worktrees`) following, then `UNIQUE(project_path, slug)` is
 * created. Rehearsed on a copy of a real user DB (371 specs, 1,579 tasks).
 *
 * ⛔ No table rebuild: the FKs have no ON UPDATE CASCADE, so the rewrite runs in
 * ONE transaction with `defer_foreign_keys` set as its first statement (see
 * `withDeferredFks`). `runMigrations` itself runs outside any transaction.
 *
 * Canonicalization here is cheap and git-free: strip a Sentinal-nested
 * `/.sentinal/worktrees/spec-*` suffix, then `realpathSync` if the path still
 * exists. Linked-worktree keys it cannot see through are healed at runtime by
 * `SpecStore` on the next registration.
 *
 * Collisions (two rows → one key) keep the newest `updated_at` (then the
 * smaller id); the loser's tasks/events are deleted and its nullable
 * references re-pointed. The version is recorded only after
 * `foreign_key_check` shows no NEW violation against `specs`, inside the same
 * transaction. A failure rolls back and is retried on the next start.
 */

import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { hasSqliteObject } from "./migration-helpers.js";
import {
  mergeSpecInto,
  renameSpec,
  specFkViolations,
  specKey,
  withDeferredFks,
} from "./spec-key.js";

const NESTED_WORKTREE = /\/\.sentinal\/worktrees\/[^/]+(?:\/.*)?$/;

export function canonicalizeSpecProject(projectPath: string): string {
  const stripped = projectPath.replace(NESTED_WORKTREE, "") || projectPath;
  try {
    return existsSync(stripped) ? realpathSync(stripped) : stripped;
  } catch {
    return stripped;
  }
}

interface Row {
  id: string;
  project_path: string;
  slug: string | null;
  updated_at: number;
}

export function migrateV14(
  db: Database,
  canonicalize: (p: string) => string = canonicalizeSpecProject,
): void {
  // Guard: no specs table yet → nothing to re-key; do NOT record, retry later.
  if (!hasSqliteObject(db, "table", "specs")) return;

  // Violations that predate V14 (e.g. rows written with FKs off) are not ours
  // to fix and must not block the migration forever.
  const baseline = specFkViolations(db).length;
  try {
    rekeyAll(db, canonicalize, baseline);
  } catch (err) {
    // ⛔ Never throw out of a migration: it runs in the MemoryStore
    // constructor, so a throw takes the sidecar down. The transaction rolled
    // back, the version is unrecorded, and the next start retries.
    console.error(
      `[sentinal] migration V14 (project-qualified spec ids) rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rekeyAll(
  db: Database,
  canonicalize: (p: string) => string,
  baseline: number,
): void {
  withDeferredFks(db, () => {
    const rows = db
      .prepare("SELECT id, project_path, slug, updated_at FROM specs")
      .all() as Row[];

    const groups = new Map<string, { project: string; rows: Row[] }>();
    for (const r of rows) {
      const project = canonicalize(r.project_path);
      const key = specKey(project, r.slug || r.id);
      const g = groups.get(key) ?? { project, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }

    // Phase 1: fold losers into winners; move every winner that needs a new
    // id to a temporary one, so no rename can land on a not-yet-moved id.
    const pending: Array<{ tmp: string; key: string; project: string }> = [];
    let n = 0;
    for (const [key, g] of groups) {
      g.rows.sort(
        (a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id),
      );
      const [winner, ...losers] = g.rows;
      for (const loser of losers) mergeSpecInto(db, loser.id, winner!.id);
      if (winner!.id === key && winner!.project_path === g.project) continue;
      const tmp = `__v14_tmp_${n++}`;
      renameSpec(db, winner!.id, tmp, g.project);
      pending.push({ tmp, key, project: g.project });
    }
    // Phase 2: temporary ids → final keys.
    for (const p of pending) renameSpec(db, p.tmp, p.key, p.project);

    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_project_slug ON specs(project_path, slug)",
    );

    const violations = specFkViolations(db).length;
    if (violations > baseline) {
      throw new Error(
        `${violations - baseline} new foreign-key violation(s) against specs`,
      );
    }
    db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (14)");
  });
}
