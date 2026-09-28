/**
 * Worktree Store — row shape, (de)serialization and scope matching.
 *
 * Split out of `store.ts` (length limit). Pure helpers over the raw
 * `worktrees` row; the one exception is {@link pickInScope}, which runs one
 * `git worktree list` through `resolveSlotScope` — never call it inside a
 * `BEGIN IMMEDIATE` transaction.
 */

import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { slugify } from "../git/utils.js";
import { resolveSpecKeyForWrite } from "../memory/spec-key.js";
import { resolveSlotScope } from "./slot-scope.js";
import type { Worktree, WorktreeStatus } from "./types.js";

/** SQL predicate for the LIVE statuses (matches `idx_wt_slot_live`). */
export const LIVE = "status IN ('active', 'ready-to-merge')";

export interface RawWorktree {
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
  slot: number | null;
  /** V15 — absent when the migration has not (yet) applied. */
  owner?: string | null;
  slug?: string | null;
}

/** Canonicalize a path for scope comparison; falls back for missing paths. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The stored form of a plan slug — `slugify`, exactly as `create.ts` derives
 * the branch name, so write and lookup always agree. Blank → `null`.
 */
export function normalizeWorktreeSlug(
  slug: string | null | undefined,
): string | null {
  if (!slug) return null;
  return slugify(slug) || null;
}

export function deserializeWorktree(row: RawWorktree): Worktree {
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
    // Explicit null (not undefined): "no slot assigned" is a real state that
    // callers must render as such, not silently drop.
    slot: row.slot ?? null,
    // Anything but an explicit 'external' is Sentinal's (pre-V15 default).
    owner: row.owner === "external" ? "external" : "sentinal",
    slug: row.slug ?? undefined,
  };
}

/**
 * INSERT one row. `owner`/`slug` are written only when they differ from the
 * column defaults, so a default row still inserts on a DB where V15 rolled
 * back and is awaiting its retry.
 */
export function insertWorktreeRow(
  db: Database,
  wt: Omit<Worktree, "mergedAt" | "mergeCommit">,
): void {
  const cols = [
    "id",
    "spec_id",
    "project_path",
    "worktree_path",
    "branch_name",
    "base_branch",
    "base_commit",
    "status",
    "created_at",
    "slot",
  ];
  const values: Array<string | number | null> = [
    wt.id,
    // D6: worktree rows keep the repo root, which is not necessarily the
    // spec's canonical key — fall back to a unique slug before failing.
    wt.specId
      ? (resolveSpecKeyForWrite(db, wt.specId, wt.projectPath) ?? wt.specId)
      : null,
    wt.projectPath,
    wt.worktreePath,
    wt.branchName,
    wt.baseBranch,
    wt.baseCommit,
    wt.status,
    wt.createdAt,
    wt.slot ?? null,
  ];
  if (wt.owner && wt.owner !== "sentinal") {
    cols.push("owner");
    values.push(wt.owner);
  }
  const slug = normalizeWorktreeSlug(wt.slug);
  if (slug !== null) {
    cols.push("slug");
    values.push(slug);
  }
  db.prepare(
    `INSERT INTO worktrees (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...values);
}

/**
 * LIVE rows whose slug column matches `slug` (slugified), newest first.
 * A DB still without the V15 column yields `[]` instead of throwing.
 */
export function liveRowsBySlugColumn(
  db: Database,
  slug: string,
): RawWorktree[] {
  const normalized = normalizeWorktreeSlug(slug);
  if (normalized === null) return [];
  try {
    return db
      .prepare(
        `SELECT * FROM worktrees WHERE slug = ? AND ${LIVE} ORDER BY created_at DESC`,
      )
      .all(normalized) as RawWorktree[];
  } catch (err) {
    if (err instanceof Error && /no such column/i.test(err.message)) return [];
    throw err;
  }
}

/**
 * Pick the first candidate in the caller's repo scope.
 *
 * ⛔ When a project scope was given, a scoped miss is FINAL (`null`) — falling
 * through to a global match would silently return another project's worktree,
 * which worktree_sync/abandon would then merge or delete there. Scope compares
 * CANONICAL paths: rows store getRepoRoot() output (a realpath), while callers
 * may pass a symlinked alias (macOS /var vs /private/var).
 *
 * Task 12: the scope is the caller's REPO, not its literal checkout. From a
 * linked worktree the caller's identity is the main checkout, where
 * canonically-keyed rows live; legacy rows keyed by any other checkout of the
 * same repo match too. One `git worktree list` — no transaction here.
 *
 * Without a scope: the first (newest) candidate.
 */
export function pickInScope(
  rows: RawWorktree[],
  projectPath: string | undefined,
): RawWorktree | null {
  if (rows.length === 0) return null;
  if (!projectPath) return rows[0] ?? null;
  const scope = resolveSlotScope(projectPath);
  const wanted = new Set(scope?.roots ?? []);
  wanted.add(canonicalPath(projectPath));
  return (
    rows.find(
      (r) =>
        wanted.has(canonicalPath(r.project_path)) ||
        (scope !== null && wanted.has(canonicalPath(r.worktree_path))),
    ) ?? null
  );
}
