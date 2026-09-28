/**
 * Worktree Store
 *
 * SQLite persistence layer for git worktree tracking.
 * Follows the SpecStore pattern: takes MemoryStore, uses getRawDb().
 */

import { resolveSpecKey } from "../memory/spec-key.js";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { MemoryStore } from "../memory/store.js";
import {
  LIVE,
  canonicalPath,
  deserializeWorktree,
  insertWorktreeRow,
  liveRowsBySlugColumn,
  pickInScope,
  type RawWorktree,
} from "./store-rows.js";
import {
  DEFAULT_WORKTREE_CONFIG,
  type Worktree,
  type WorktreeStatus,
} from "./types.js";

// ─── Store ──────────────────────────────────────────────────────────────────

export class WorktreeStore {
  private db: Database;

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getRawDb();
  }

  /**
   * Insert a new worktree record. `owner` defaults to `sentinal`; `slug` is
   * stored slugified (V15).
   */
  insert(wt: Omit<Worktree, "mergedAt" | "mergeCommit">): Worktree {
    insertWorktreeRow(this.db, wt);
    return this.get(wt.id)!;
  }

  /** Get a worktree by ID. */
  get(id: string): Worktree | null {
    const row = this.db
      .prepare("SELECT * FROM worktrees WHERE id = ?")
      .get(id) as RawWorktree | null;
    return row ? this.deserialize(row) : null;
  }

  /**
   * Get the active worktree for a spec (not merged or abandoned). Accepts the
   * spec key or its slug, resolved within `projectPath` when given (D6).
   */
  getBySpecId(specId: string, projectPath?: string): Worktree | null {
    const key = resolveSpecKey(this.db, specId, projectPath);
    if (!key) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM worktrees WHERE spec_id = ? AND status IN ('active', 'ready-to-merge') ORDER BY created_at DESC LIMIT 1",
      )
      .get(key) as RawWorktree | null;
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
      .run(resolveSpecKey(this.db, specId) ?? specId, id);
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

  /**
   * Count active worktrees, optionally scoped to a project.
   *
   * With `roots` (a {@link SlotScope}'s), counts the CANONICAL set — every
   * active row whose `project_path` or `worktree_path` is a checkout of the
   * repo, however it was keyed. Without it, the literal-key count (unchanged).
   */
  countActive(projectPath?: string, roots?: Iterable<string>): number {
    if (projectPath && roots) {
      const set = new Set(roots);
      set.add(projectPath);
      const rows = this.db
        .prepare(
          "SELECT project_path, worktree_path FROM worktrees WHERE status = 'active'",
        )
        .all() as Array<Pick<RawWorktree, "project_path" | "worktree_path">>;
      return rows.filter(
        (r) => set.has(r.project_path) || set.has(r.worktree_path),
      ).length;
    }
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

  // ─── Slots ────────────────────────────────────────────────────────────

  /**
   * The slots currently held by **live** worktrees of `projectPath`, ascending.
   *
   * ⛔ "Live" is `('active','ready-to-merge')`, matching the `idx_wt_slot_live`
   * partial unique index exactly. Filtering on `'active'` alone here would let
   * the allocator hand out the slot of a `ready-to-merge` worktree that is
   * still on disk — and the DB would then reject the insert anyway.
   *
   * Rows with `slot IS NULL` (pre-V12, or a reconcile that found no free slot)
   * are omitted: they hold nothing.
   */
  listLiveSlots(projectPath: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT slot FROM worktrees
          WHERE project_path = ?
            AND slot IS NOT NULL
            AND status IN ('active', 'ready-to-merge')
          ORDER BY slot ASC`,
      )
      .all(projectPath) as Array<{ slot: number }>;
    return rows.map((r) => r.slot);
  }

  /**
   * Assign a slot to an existing row.
   *
   * ⚠️ This exists **only** for lazy allocation of pre-V12 rows that carry
   * `slot = NULL` (master plan assumption: "allocated lazily on next resolve").
   * It is NOT a release mechanism — nothing in production writes
   * `slot = NULL` on release, because that would destroy the record of which
   * slot a merged/abandoned worktree held, which is what lets
   * `resolveWithReconcile` recover the slot its on-disk config was written
   * against.
   *
   * ⚠️ ONE deliberate, transient exception (D4): {@link unifyLiveKeys} nulls
   * the LIVE loser of a slot collision revealed by a re-key, and the allocator
   * re-slots it right after commit (`slots.ts` → `reslotLosers`). Terminal rows
   * are never nulled.
   */
  assignSlot(id: string, slot: number): void {
    this.db.prepare("UPDATE worktrees SET slot = ? WHERE id = ?").run(slot, id);
  }

  /**
   * Lazy re-key (D6): move every LIVE row of one repo onto the canonical `key`.
   * SQL only — must run inside {@link runImmediate}; `roots` comes from a
   * {@link resolveSlotScope} call made BEFORE the transaction.
   *
   * Rows are "of this repo" when `project_path` or `worktree_path` is in
   * `roots`. Other repos' rows and merged/abandoned rows are never touched.
   *
   * ⛔ Order is load-bearing: (1) group by slot — after the re-key every row is
   * under `key`, so these are the `(key, slot)` groups; (2) null every LOSER
   * (all but the oldest `created_at`) FIRST; (3) only then re-key. Re-keying
   * first raises `idx_wt_slot_live`, which `isSlotRace` misreads as a lost
   * race — the allocator would retry and report a deterministic collision as
   * a transient `SLOT_RACE`, forever.
   *
   * @returns the losers, carrying the slot they held BEFORE being nulled — the
   *   caller must re-slot them after commit (D4).
   */
  unifyLiveKeys(key: string, roots: Iterable<string>): Worktree[] {
    const inScope = new Set(roots);
    inScope.add(key);
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM worktrees WHERE ${LIVE} ORDER BY created_at ASC, id ASC`,
        )
        .all() as RawWorktree[]
    ).filter(
      (r) => inScope.has(r.project_path) || inScope.has(r.worktree_path),
    );

    const holders = new Set<number>();
    const losers: RawWorktree[] = [];
    for (const r of rows) {
      if (r.slot === null) continue;
      if (holders.has(r.slot)) losers.push(r);
      else holders.add(r.slot);
    }

    const nullSlot = this.db.prepare(
      "UPDATE worktrees SET slot = NULL WHERE id = ?",
    );
    for (const l of losers) nullSlot.run(l.id);

    const rekey = this.db.prepare(
      "UPDATE worktrees SET project_path = ? WHERE id = ?",
    );
    for (const r of rows) {
      if (r.project_path !== key) rekey.run(key, r.id);
    }

    return losers.map((l) => ({ ...this.deserialize(l), projectPath: key }));
  }

  /**
   * Run `fn` inside a `BEGIN IMMEDIATE` transaction.
   *
   * ⚠️ Bun's `db.transaction()` defaults to DEFERRED, which takes no write lock
   * until the first write — leaving a read-then-write sequence (allocate, then
   * insert) racy across the CLI, MCP server and sidecar, which all open the
   * same DB file. IMMEDIATE takes the write lock up front.
   */
  runImmediate<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx.immediate() as T;
  }

  /**
   * Resolve a plan slug to a worktree.
   * 1. Try exact match on spec_id (primary)
   * 2. The V15 `slug` column (slugified like `create.ts`) — finds adopted
   *    worktrees whose branch carries no Sentinal prefix
   * 3. Fall back to an exact branch-name match (`<prefix><slug>` or legacy
   *    `spec/<slug>`)
   * Steps 2–3 are scoped to `projectPath` when given — a scoped miss returns
   * null and never falls through to another project's worktree.
   * Returns null if no match.
   */
  resolveBySlug(slug: string, projectPath?: string): Worktree | null {
    // Primary: the spec's key (slug scoped to the project when given — D6).
    const bySpec = this.getBySpecId(
      slug,
      projectPath ? canonicalPath(projectPath) : undefined,
    );
    if (bySpec) return bySpec;

    // V15: the slug the worktree was ensured under (same scoping as below).
    const bySlug = pickInScope(
      liveRowsBySlugColumn(this.db, slug),
      projectPath,
    );
    if (bySlug) return this.deserialize(bySlug);

    // Branch names: the configured prefix (default "sentinal/spec-") plus
    // the legacy "spec/" prefix. Records often have spec_id=NULL because
    // linkSpec() runs after spec registration — branch matching must use the
    // prefix worktree_create actually writes. Anchored EXACT match (H4):
    // create.ts writes exactly `${prefix}${slug}` (never suffixed — only the
    // id and worktree PATH carry a hash), so a bare LIKE `${prefix}${slug}%`
    // wrongly let slug `add` match branch `.../add-auth`.
    const branches = [
      `${DEFAULT_WORKTREE_CONFIG.branchPrefix}${slug}`,
      `spec/${slug}`,
    ];

    // Fetch candidates by exact branch, then scope in TS (small table;
    // correctness over cleverness).
    const rows = this.db
      .prepare(
        "SELECT * FROM worktrees WHERE branch_name IN (?, ?) AND status IN ('active', 'ready-to-merge') ORDER BY created_at DESC",
      )
      .all(...branches) as RawWorktree[];

    // ⛔ A scoped miss is FINAL (see pickInScope); the global fallback applies
    // ONLY when no scope was given.
    const row = pickInScope(rows, projectPath);
    return row ? this.deserialize(row) : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private deserialize(row: RawWorktree): Worktree {
    return deserializeWorktree(row);
  }
}
