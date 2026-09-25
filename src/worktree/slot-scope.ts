/**
 * Worktree slot — repo scope resolution (Task 12; see `slots.ts`).
 *
 * ⛔ The pool is the REPO, not the checkout. Every allocation first unifies this
 * repo's live rows under the canonical key, with the repo's roots resolved by
 * ONE `git worktree list` BEFORE the transaction — never inside it.
 */

import {
  listGitWorktrees,
  resolveRealPath,
  type GitWorktreeEntry,
} from "./disk-scan.js";

/**
 * Which rows belong to ONE repository, however they were keyed.
 *
 * - `key` — the canonical project key: the main checkout, realpath'd. Equal to
 *   `resolveProjectIdentity()` / `getMainWorktreeRoot()` for the same repo.
 * - `roots` — every checkout of the repo (main + linked worktrees), both as git
 *   printed them and realpath'd. A row is "of this repo" when its
 *   `project_path` OR its `worktree_path` is one of these.
 */
export interface SlotScope {
  key: string;
  roots: string[];
}

/** Injectable `git worktree list` — tests use it to prove WHEN git runs. */
export type WorktreeLister = (repoRoot: string) => GitWorktreeEntry[];

/**
 * Resolve the {@link SlotScope} of the repo containing `projectPath` with ONE
 * `git worktree list --porcelain`. `null` outside a repository (or when git
 * cannot run there) — callers then fall back to the literal key.
 *
 * ⛔ Spawns git. Call it BEFORE `runImmediate`, never inside: the allocating
 * transaction also runs on the read-only `worktree_detect` path, and a
 * subprocess while holding the write lock stalls every other writer.
 */
export function resolveSlotScope(
  projectPath: string,
  lister: WorktreeLister = listGitWorktrees,
): SlotScope | null {
  let entries: GitWorktreeEntry[];
  try {
    entries = lister(projectPath);
  } catch {
    return null; // e.g. the directory does not exist
  }
  if (entries.length === 0) return null;
  const roots = new Set<string>();
  for (const e of entries) {
    roots.add(e.path);
    roots.add(resolveRealPath(e.path));
  }
  return { key: resolveRealPath(entries[0].path), roots: [...roots] };
}

/**
 * Scope for an allocation — resolved OUTSIDE any transaction. An explicit
 * `scope` (including `null`, which forces the literal key) wins; otherwise one
 * git call resolves it.
 */
export function scopeFor(
  projectPath: string,
  opts: { scope?: SlotScope | null; listWorktrees?: WorktreeLister },
): SlotScope | null {
  if (opts.scope !== undefined) return opts.scope;
  return resolveSlotScope(projectPath, opts.listWorktrees);
}
