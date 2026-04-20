/**
 * Worktree Store
 *
 * SQLite persistence layer for git worktree tracking.
 * Follows the SpecStore pattern: takes MemoryStore, uses getRawDb().
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { MemoryStore } from "../memory/store.js";
import type { Worktree, WorktreeStatus } from "./types.js";

// ─── Raw DB Row Type ────────────────────────────────────────────────────────

interface RawWorktree {
  id: string;
  spec_id: string | null;
  project_path: string;
  worktree_path: string;
  branch_name: string;
  base_branch: string;
  base_commit: string;
  status: string;
  created_at: number;
  merged_at: number | null;
  merge_commit: string | null;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class WorktreeStore {
  private db: Database;

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getRawDb();
  }

  /** Insert a new worktree record. */
  insert(wt: Omit<Worktree, "mergedAt" | "mergeCommit">): Worktree {
    this.db
      .prepare(
        `INSERT INTO worktrees (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wt.id,
        wt.specId ?? null,
        wt.projectPath,
        wt.worktreePath,
        wt.branchName,
        wt.baseBranch,
        wt.baseCommit,
        wt.status,
        wt.createdAt,
      );
    return this.get(wt.id)!;
  }

  /** Get a worktree by ID. */
  get(id: string): Worktree | null {
    const row = this.db
      .prepare("SELECT * FROM worktrees WHERE id = ?")
      .get(id) as RawWorktree | null;
    return row ? this.deserialize(row) : null;
  }

  /** Get the active worktree for a spec (not merged or abandoned). */
  getBySpecId(specId: string): Worktree | null {
    const row = this.db
      .prepare(
        "SELECT * FROM worktrees WHERE spec_id = ? AND status IN ('active', 'ready-to-merge') ORDER BY created_at DESC LIMIT 1",
      )
      .get(specId) as RawWorktree | null;
    return row ? this.deserialize(row) : null;
  }

  /** List worktrees for a project, optionally filtered by status. */
  listForProject(projectPath: string, status?: WorktreeStatus): Worktree[] {
    let sql = "SELECT * FROM worktrees WHERE project_path = ?";
    const params: SQLQueryBindings[] = [projectPath];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(...params) as RawWorktree[];
    return rows.map((r) => this.deserialize(r));
  }

  /** List all worktrees, optionally filtered by status. */
  listAll(status?: WorktreeStatus): Worktree[] {
    let sql = "SELECT * FROM worktrees";
    const params: SQLQueryBindings[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(...params) as RawWorktree[];
    return rows.map((r) => this.deserialize(r));
  }

  /** Update worktree status and optionally set merge info. */
  updateStatus(id: string, status: WorktreeStatus, mergeCommit?: string): void {
    if (status === "merged" && mergeCommit) {
      this.db
        .prepare(
          "UPDATE worktrees SET status = ?, merged_at = ?, merge_commit = ? WHERE id = ?",
        )
        .run(status, Date.now(), mergeCommit, id);
    } else {
      this.db
        .prepare("UPDATE worktrees SET status = ? WHERE id = ?")
        .run(status, id);
    }
  }

  /** Update the spec_id for a worktree (deferred FK linkage). */
  updateSpecId(id: string, specId: string): void {
    this.db
      .prepare("UPDATE worktrees SET spec_id = ? WHERE id = ?")
      .run(specId, id);
  }

  /** Delete a worktree record. Returns true if a row was deleted. */
  delete(id: string): boolean {
    const exists = this.db
      .prepare("SELECT 1 FROM worktrees WHERE id = ?")
      .get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM worktrees WHERE id = ?").run(id);
    return true;
  }

  /** Count active worktrees, optionally scoped to a project. */
  countActive(projectPath?: string): number {
    if (projectPath) {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) as count FROM worktrees WHERE status = 'active' AND project_path = ?",
        )
        .get(projectPath) as { count: number };
      return row.count;
    }
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM worktrees WHERE status = 'active'",
      )
      .get() as { count: number };
    return row.count;
  }

  /**
   * Resolve a plan slug to a worktree.
   * 1. Try exact match on spec_id (primary)
   * 2. Fall back to branch name pattern matching `spec/<slug>*` if projectPath given
   * Returns null if no match.
   */
  resolveBySlug(slug: string, projectPath?: string): Worktree | null {
    // Primary: exact spec_id match
    const bySpec = this.getBySpecId(slug);
    if (bySpec) return bySpec;

    // Fallback: match by branch name pattern for active worktrees
    if (projectPath) {
      const pattern = `spec/${slug}%`;
      const row = this.db
        .prepare(
          "SELECT * FROM worktrees WHERE project_path = ? AND branch_name LIKE ? AND status IN ('active', 'ready-to-merge') ORDER BY created_at DESC LIMIT 1",
        )
        .get(projectPath, pattern) as RawWorktree | null;
      if (row) return this.deserialize(row);
    }

    // Global fallback: match by branch name without project scope
    const pattern = `spec/${slug}%`;
    const row = this.db
      .prepare(
        "SELECT * FROM worktrees WHERE branch_name LIKE ? AND status IN ('active', 'ready-to-merge') ORDER BY created_at DESC LIMIT 1",
      )
      .get(pattern) as RawWorktree | null;
    if (row) return this.deserialize(row);

    return null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private deserialize(row: RawWorktree): Worktree {
    return {
      id: row.id,
      specId: row.spec_id ?? undefined,
      projectPath: row.project_path,
      worktreePath: row.worktree_path,
      branchName: row.branch_name,
      baseBranch: row.base_branch,
      baseCommit: row.base_commit,
      status: row.status as WorktreeStatus,
      createdAt: row.created_at,
      mergedAt: row.merged_at ?? undefined,
      mergeCommit: row.merge_commit ?? undefined,
    };
  }
}
