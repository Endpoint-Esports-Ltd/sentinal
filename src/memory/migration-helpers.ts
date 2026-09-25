/**
 * Migration Helpers
 *
 * Small schema-introspection predicates shared by the modern migrations.
 */

import type { Database } from "bun:sqlite";

export const hasColumn = (db: Database, table: string, col: string): boolean =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((c) => c.name === col);

export const hasSqliteObject = (
  db: Database,
  type: string,
  name: string,
): boolean =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?")
    .all(type, name).length > 0;
