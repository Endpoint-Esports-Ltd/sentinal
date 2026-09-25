/**
 * Database Migrations
 *
 * Sequential migration functions for the Sentinal SQLite schema.
 * Extracted from MemoryStore to keep file sizes manageable.
 */

import type { Database } from "bun:sqlite";
import { DB_CONSTANTS } from "./types.js";
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

// ─── Migration Runner ─────────────────────────────────────────────────────────

export function runMigrations(db: Database, dbPath: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db
    .prepare("SELECT MAX(version) as version FROM schema_version")
    .get() as { version: number | null } | null;
  const currentVersion = row?.version ?? 0;

  // Backup before applying migrations (skip for fresh databases)
  let backupPath: string | null = null;
  if (currentVersion > 0 && currentVersion < DB_CONSTANTS.SCHEMA_VERSION) {
    try {
      backupPath = backupDatabase(dbPath);
    } catch {
      // Backup failure should not block migration
    }
  }

  if (currentVersion < 1) migrateV1(db);
  if (currentVersion < 2) migrateV2(db);
  if (currentVersion < 3) migrateV3(db);
  if (currentVersion < 4) migrateV4(db);
  if (currentVersion < 5) migrateV5(db);
  if (currentVersion < 6) migrateV6(db);
  if (currentVersion < 7) migrateV7(db);
  if (currentVersion < 8) migrateV8(db);
  if (currentVersion < 9) migrateV9(db);
  if (currentVersion < 10) migrateV10(db);
  if (currentVersion < 11) migrateV11(db);
  if (currentVersion < 12) migrateV12(db);
  if (currentVersion < 13) migrateV13(db, backupPath);
}
