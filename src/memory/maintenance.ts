/**
 * Database Maintenance
 *
 * Recovery and maintenance operations for the memory database:
 * - FTS index rebuild (fixes corruption)
 * - Vector index rebuild (re-indexes all observations)
 * - Database backup before migrations
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import type { MemoryStore } from "./store.js";
import type { VectorStore } from "./vector-store.js";

// ─── FTS Rebuild ──────────────────────────────────────────────────────────────

/**
 * Rebuild the FTS5 index from the observations table.
 * Use when FTS results are incorrect or the index is corrupted.
 * Returns the number of observations re-indexed.
 */
export function rebuildFtsIndex(store: MemoryStore): number {
  const db = store.getRawDb();

  // The 'rebuild' command reconstructs the FTS index from the content table
  try {
    db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  } catch {
    // If rebuild command fails, try drop + recreate approach
    db.run("DROP TABLE IF EXISTS observations_fts");
    db.run(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title, content, tags, content=observations, content_rowid=id
      )
    `);
    db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  const row = db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number };
  return row.count;
}

// ─── Vector Rebuild ───────────────────────────────────────────────────────────

/**
 * Rebuild the vector index by re-indexing all observations.
 * Use when vector search results are incorrect or after schema changes.
 * Returns the number of observations re-indexed.
 */
export async function rebuildVectorIndex(
  store: MemoryStore,
  vectorStore: VectorStore,
): Promise<number> {
  if (!vectorStore.isAvailable()) {
    throw new Error("Vector store is not available. Cannot rebuild vector index.");
  }

  const db = store.getRawDb();

  // Clear existing vectors
  try {
    db.run("DELETE FROM observation_vectors");
  } catch {
    // Table might not exist yet — that's fine, initialize will create it
  }

  // Re-index all observations
  const rows = db.prepare(
    "SELECT id, title, content, tags, project_path, timestamp FROM observations ORDER BY id",
  ).all() as Array<{
    id: number;
    title: string;
    content: string;
    tags: string;
    project_path: string;
    timestamp: number;
  }>;

  let indexed = 0;
  for (const row of rows) {
    const tags: string[] = JSON.parse(row.tags || "[]");
    const count = await vectorStore.indexObservation(
      row.id,
      row.title,
      row.content,
      tags,
      row.project_path,
      row.timestamp,
    );
    if (count > 0) indexed++;
  }

  return indexed;
}

// ─── Database Backup ──────────────────────────────────────────────────────────

/**
 * Create a backup of the database file before risky operations (migrations, rebuilds).
 * The backup is saved alongside the original with a `.bak` suffix.
 * Returns the backup file path, or null if backup wasn't needed (in-memory DB).
 */
export function backupDatabase(dbPath: string): string | null {
  // Skip backup for in-memory databases
  if (dbPath === ":memory:" || dbPath === "") return null;

  if (!existsSync(dbPath)) return null;

  const backupPath = `${dbPath}.bak`;
  copyFileSync(dbPath, backupPath);

  // Also backup WAL and SHM files if they exist
  if (existsSync(`${dbPath}-wal`)) {
    copyFileSync(`${dbPath}-wal`, `${backupPath}-wal`);
  }
  if (existsSync(`${dbPath}-shm`)) {
    copyFileSync(`${dbPath}-shm`, `${backupPath}-shm`);
  }

  return backupPath;
}

/**
 * Verify database integrity using SQLite's built-in integrity check.
 * Returns null if OK, or a list of issues found.
 */
export function checkIntegrity(store: MemoryStore): string[] | null {
  const db = store.getRawDb();
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;

  if (rows.length === 1 && rows[0].integrity_check === "ok") {
    return null;
  }

  return rows.map((r) => r.integrity_check);
}
