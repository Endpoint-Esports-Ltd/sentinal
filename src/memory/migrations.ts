/**
 * Database Migrations
 *
 * Sequential migration functions for the Sentinal SQLite schema.
 * Extracted from MemoryStore to keep file sizes manageable.
 */

import type { Database } from "bun:sqlite";
import { backupDatabase } from "./maintenance.js";
import {
  migrateV1,
  migrateV2,
  migrateV3,
  migrateV4,
  migrateV5,
  migrateV6,
  migrateV7,
  migrateV8,
  migrateV9,
  migrateV10,
} from "./migrations-legacy.js";
import { migrateV11 } from "./migrations-v11.js";
import { migrateV12 } from "./migrations-v12.js";
import { migrateV13 } from "./migrations-v13.js";
import { migrateV14 } from "./migrations-v14.js";

// ─── Migration Runner ─────────────────────────────────────────────────────────

export function runMigrations(db: Database, dbPath: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  // D7: run every UNRECORDED step, in order — not "everything above MAX".
  // A step whose guard declines does not record itself so it can retry; with
  // MAX, the first later step to record made that retry impossible forever.
  // Steps below the LOWEST recorded version count as applied (a DB seeded at
  // some version never recorded the steps before it).
  const recorded = new Set(
    (
      db.prepare("SELECT version FROM schema_version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version),
  );
  const floor = recorded.size > 0 ? Math.min(...recorded) : 0;
  const pending = STEPS.filter(
    ([version]) => version > floor && !recorded.has(version),
  );
  if (pending.length === 0) return;

  // Backup before applying migrations (skip for fresh databases)
  let backupPath: string | null = null;
  if (recorded.size > 0) {
    try {
      backupPath = backupDatabase(dbPath);
    } catch {
      // Backup failure should not block migration
    }
  }

  for (const [, step] of pending) step(db, backupPath);
}

type Step = (db: Database, backupPath: string | null) => void;

const STEPS: ReadonlyArray<readonly [number, Step]> = [
  [1, migrateV1],
  [2, migrateV2],
  [3, migrateV3],
  [4, migrateV4],
  [5, migrateV5],
  [6, migrateV6],
  [7, migrateV7],
  [8, migrateV8],
  [9, migrateV9],
  [10, migrateV10],
  [11, migrateV11],
  [12, migrateV12],
  [13, (db, backupPath) => migrateV13(db, backupPath)],
  [14, (db) => migrateV14(db)],
];
