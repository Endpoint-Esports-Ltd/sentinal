/**
 * Veto for `orca_remove_worktree` (spec review must_fix of
 * docs/plans/2026-09-28-orca-orchestration.md).
 *
 * `orca worktree rm` deletes a worktree directory and its Orca metadata. The
 * Orca tool may only remove a CHILD worktree that Sentinal has already
 * released. It refuses:
 *   - a path that is not a worktree of this repo;
 *   - the main checkout;
 *   - the calling session's own checkout (the coordinator);
 *   - any worktree Sentinal still holds live (active / ready-to-merge row),
 *     which must be released with `worktree_abandon` first so its slot and
 *     seeded files are handed back.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { listGitWorktrees } from "./disk-scan.js";
import type { WorktreeStore } from "./store.js";

export type RemovalVerdict = { ok: true } | { ok: false; reason: string };

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export async function guardOrcaWorktreeRemoval(
  path: string,
  opts: { cwd: string; store: WorktreeStore | null },
): Promise<RemovalVerdict> {
  const target = real(path);
  const entries = listGitWorktrees(opts.cwd);
  if (entries.length === 0) {
    return { ok: false, reason: "this session is not inside a git repository" };
  }
  const paths = entries.map((e) => real(e.path));
  if (!paths.includes(target)) {
    return { ok: false, reason: "it is not a worktree of this repository" };
  }
  if (paths[0] === target) {
    return { ok: false, reason: "it is the main checkout" };
  }
  const own = entries.find((e) => {
    const p = real(e.path);
    const c = real(opts.cwd);
    return c === p || c.startsWith(p + "/");
  });
  if (own && real(own.path) === target) {
    return { ok: false, reason: "it is this session's own checkout" };
  }
  const live = (opts.store?.listAll() ?? []).find(
    (w) =>
      real(w.worktreePath) === target &&
      (w.status === "active" || w.status === "ready-to-merge"),
  );
  if (live) {
    return {
      ok: false,
      reason:
        `Sentinal still holds it (worktree ${live.id}, ${live.status}) — ` +
        "call worktree_abandon first to release its slot and seeded files",
    };
  }
  return { ok: true };
}
