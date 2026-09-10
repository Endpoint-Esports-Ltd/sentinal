/**
 * Worktree Disk Scan
 *
 * Reading `git worktree list --porcelain` and the path-containment helpers that
 * guard destructive cleanup. Extracted verbatim from `manager.ts`, which sits
 * against Sentinal's 600-line hard block (R4).
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { gitExec } from "../git/utils.js";

/** One entry from `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

/**
 * Parse `git worktree list --porcelain` into entries.
 * Skips detached/bare entries (no branch line) and returns `[]` outside a repo.
 */
export function listGitWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const result = gitExec(["worktree", "list", "--porcelain"], repoRoot);
  if (result.exitCode !== 0) return [];

  const entries: GitWorktreeEntry[] = [];
  for (const block of result.stdout.split("\n\n")) {
    let path = "";
    let head = "";
    let branch = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch "))
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
    if (path && branch) entries.push({ path, head, branch });
  }
  return entries;
}

/** Canonicalize a path (resolve symlinks); fall back to a plain resolve. */
export function resolveRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True if `child` is **strictly** inside `parent` (both resolved).
 *
 * The trailing-separator handling is load-bearing: without it a sibling named
 * `<parent>-evil` would test as "inside" and become eligible for force cleanup.
 */
export function isInside(child: string, parent: string): boolean {
  const c = resolveRealPath(child);
  const pRoot = resolveRealPath(parent);
  return c !== pRoot && c.startsWith(pRoot.endsWith(sep) ? pRoot : pRoot + sep);
}
