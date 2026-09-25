/**
 * Project-qualified spec keys (D6 of docs/plans/2026-09-24-hardening-sweep.md).
 *
 * `specs.id` is `<canonicalProject>::<slug>` — an OPAQUE key: never parse it.
 * The slug (bare plan filename) lives in `specs.slug`, the project in
 * `specs.project_path`; `UNIQUE(project_path, slug)` makes the pair the real
 * identity. The public `Spec.id` stays the slug, so every caller comparing it
 * with a parsed plan keeps working; stores resolve whatever they are handed
 * through `resolveSpecKey` before it touches a foreign key.
 *
 * Lives in `src/memory/` (not `src/spec/`) because the memory stores, which
 * `SpecStore` itself depends on, need it too — no memory → spec import cycle.
 */

import type { Database } from "bun:sqlite";

export function specKey(project: string, slug: string): string {
  return `${project}::${slug}`;
}

/**
 * Map a key OR a bare slug onto the stored `specs.id`:
 *   1. an exact stored id (a key, or a pre-V14 bare id) wins;
 *   2. with a project: that project's row for the slug — never another
 *      project's, even when the slug is unique elsewhere;
 *   3. without one: the slug only if exactly one project has it.
 * Anything else (unknown, ambiguous) → `null`. Never guesses.
 *
 * `project` must already be canonical (callers normalize at their boundary).
 */
export function resolveSpecKey(
  db: Database,
  value: string | null | undefined,
  project?: string | null,
): string | null {
  if (!value) return null;
  const exact = db.prepare("SELECT id FROM specs WHERE id = ?").get(value) as {
    id: string;
  } | null;
  if (exact) return exact.id;

  if (project) {
    const row = db
      .prepare("SELECT id FROM specs WHERE project_path = ? AND slug = ?")
      .get(project, value) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db
    .prepare("SELECT id FROM specs WHERE slug = ? LIMIT 2")
    .all(value) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * `resolveSpecKey` for FK WRITERS: the supplied project's row first, then a
 * slug that exists in exactly one project. A write often carries a raw or
 * inferred project (e.g. `/` for a file with no existing ancestor), and the
 * caller named the spec explicitly — refusing a unique slug would only turn a
 * correct link into an FK failure. An ambiguous slug is still refused.
 */
export function resolveSpecKeyForWrite(
  db: Database,
  value: string | null | undefined,
  project?: string | null,
): string | null {
  return (
    resolveSpecKey(db, value, project) ??
    (project ? resolveSpecKey(db, value) : null)
  );
}

// ─── Re-keying (shared by migration V14 and the runtime heal) ────────────────

/** Tables whose `spec_id` references `specs(id)`, and whether it is nullable. */
const SPEC_CHILDREN = [
  { table: "spec_tasks", nullable: false },
  { table: "spec_events", nullable: false },
  { table: "notifications", nullable: true },
  { table: "tdd_cycles", nullable: true },
  { table: "worktrees", nullable: true },
] as const;

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== null
  );
}

/**
 * Run `fn` in a transaction with FK checks deferred to COMMIT.
 *
 * ⛔ `defer_foreign_keys` has NO effect in autocommit and resets at COMMIT, so
 * it must be the first statement INSIDE the transaction. Rewriting a parent key
 * that children reference is only legal because the check is deferred until
 * both sides agree again.
 */
export function withDeferredFks(db: Database, fn: () => void): void {
  db.transaction(() => {
    db.run("PRAGMA defer_foreign_keys = ON");
    fn();
  })();
}

/**
 * Fold `loserId` into `winnerId` (both existing ids). Its tasks and events are
 * DELETED — re-pointing them would violate `UNIQUE(spec_id, position)` — and
 * its nullable references are re-pointed. Call inside `withDeferredFks`.
 */
export function mergeSpecInto(
  db: Database,
  loserId: string,
  winnerId: string,
): void {
  for (const { table, nullable } of SPEC_CHILDREN) {
    if (!tableExists(db, table)) continue;
    if (nullable) {
      db.prepare(`UPDATE ${table} SET spec_id = ? WHERE spec_id = ?`).run(
        winnerId,
        loserId,
      );
    } else {
      db.prepare(`DELETE FROM ${table} WHERE spec_id = ?`).run(loserId);
    }
  }
  db.prepare("DELETE FROM specs WHERE id = ?").run(loserId);
}

/**
 * Rename a spec row's id (and project) and every reference to it. Call inside
 * `withDeferredFks`. The target id must not exist.
 */
export function renameSpec(
  db: Database,
  fromId: string,
  toId: string,
  toProject: string,
): void {
  db.prepare("UPDATE specs SET id = ?, project_path = ? WHERE id = ?").run(
    toId,
    toProject,
    fromId,
  );
  for (const { table } of SPEC_CHILDREN) {
    if (!tableExists(db, table)) continue;
    db.prepare(`UPDATE ${table} SET spec_id = ? WHERE spec_id = ?`).run(
      toId,
      fromId,
    );
  }
}

/** FK violations that point at `specs` (must be empty before COMMIT). */
export function specFkViolations(db: Database): unknown[] {
  return (
    db.prepare("PRAGMA foreign_key_check").all() as Array<{ parent: string }>
  ).filter((v) => v.parent === "specs");
}
