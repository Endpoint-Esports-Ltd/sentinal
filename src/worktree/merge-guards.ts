/**
 * The two guards that keep `squashMerge` from claiming a worktree is `merged`
 * while its directory is still on disk.
 *
 * ## The defect these exist for
 *
 * `squashMerge` used to remove the worktree with a bare
 * `gitExec(["worktree", "remove", path])` — **no `--force`**, and no check of
 * the result. `git worktree remove` refuses (exit 128, "contains modified or
 * untracked files") whenever the worktree holds anything git can see, so the
 * refusal was **swallowed** and the row was marked `merged` anyway. `merged` is
 * terminal, so it is outside `LIVE_WORKTREE_STATUSES` and the partial unique
 * index frees the row's slot — while the directory, its seeded `.env` and its
 * ports survive. The next worktree is handed that slot and collides with a
 * checkout that is still there. **A silent slot release with a surviving
 * directory is the worst of both outcomes.**
 *
 * R9 made it materially reachable: `.sentinal/runtime.json` is deliberately
 * COMMITTABLE, so it is not covered by the worktree-local `.gitignore` Sentinal
 * writes for its own seeded files, and a `/sync`-scaffolded-but-uncommitted
 * contract is exactly such an untracked file.
 *
 * ## Why NOT `--force`
 *
 * `abandon` passes `--force` and is right to: abandoning **is** a discard, and
 * the user asked for one. A merge is the opposite. Modified-or-untracked files
 * are by definition **not on the branch**, so `git merge --squash` does not
 * carry them across; `--force` here would delete the only copy of work the user
 * never agreed to lose, silently, on the normal end-of-spec path. Sentinal does
 * not get to make that call on the user's behalf.
 *
 * So: **refuse instead**, and never mark `merged` on a directory that survived.
 *
 * ## Why a preflight AND a post-hoc check
 *
 * They cover different failures and neither subsumes the other.
 *
 * - {@link assertCleanForMerge} runs **before anything is done**, so the common
 *   case (a file that was already there) costs the user nothing — no checkout,
 *   no merge commit; resolve it and re-run the same command.
 * - {@link removeMergedWorktree} covers what the preflight cannot see: a file
 *   created between the two points, a permissions failure, a lock. By then the
 *   merge has already landed, which is a genuinely different situation and gets
 *   a genuinely different error code.
 *
 * ⛔ Must import NOTHING from `src/runtime/` — see
 * `src/runtime/no-module-cycle.test.ts`.
 */

import { existsSync } from "node:fs";
import { gitExec } from "../git/utils.js";
import { WorktreeError, type Worktree } from "./types.js";

/** Enough to identify the problem without pasting a thousand-line status. */
const MAX_LISTED_PATHS = 10;

/**
 * Paths in `worktreePath` that git can see and would refuse to remove.
 *
 * `--untracked-files=all` is load-bearing: the default collapses an untracked
 * directory to `?? .sentinal/`, which names the container rather than the file
 * and would point the reader at the wrong thing.
 *
 * Ignored files are deliberately **not** listed. Sentinal's own seeded `.env`
 * and `.sentinal/worktree.env` are hidden behind a worktree-local `.gitignore`,
 * and `git worktree remove` deletes an ignored-only worktree without complaint
 * (verified) — so treating them as blockers would refuse every merge.
 */
export function gitVisibleChanges(worktreePath: string): string[] {
  const status = gitExec(
    ["status", "--porcelain", "--untracked-files=all"],
    worktreePath,
  );
  if (status.exitCode !== 0) return [];
  return (
    status.stdout
      .split("\n")
      // ⛔ NOT `slice(3)`. Porcelain's status field is two columns, but `gitExec`
      // trims its stdout, so the FIRST line of a modified-file status (`" M foo"`)
      // arrives already shifted by one and a fixed offset silently eats a
      // character of the path — reporting `EADME.md`. Trim each line and strip the
      // status by shape instead.
      .map((l) => l.trim().replace(/^\S{1,2}\s+/, ""))
      .filter((l) => l.length > 0)
  );
}

/** `paths`, truncated, as a readable inline list. */
function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  const rest = paths.length - MAX_LISTED_PATHS;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * Refuse the merge if the worktree holds work the merge would not carry and the
 * removal would then choke on. Throws `DIRTY_WORKTREE`; **nothing has been
 * done** when it does.
 */
export function assertCleanForMerge(wt: Worktree): void {
  const dirty = gitVisibleChanges(wt.worktreePath);
  if (dirty.length === 0) return;

  throw new WorktreeError(
    `Refusing to merge ${wt.branchName}: ${wt.worktreePath} has ${dirty.length} ` +
      `modified or untracked file(s) — ${listPaths(dirty)}. ` +
      `These are NOT on the branch, so the squash would not carry them across, and ` +
      `git then refuses to remove the directory that holds the only copy. Merging ` +
      `anyway would mark this worktree merged, release its slot to the next ` +
      `worktree, and leave this directory and its config on disk pointing at the ` +
      `same ports and databases. ` +
      `Remedy: commit them in the worktree so they are part of the squash, delete ` +
      `them, or use worktree_abandon to discard the whole worktree. ` +
      `Nothing has been merged — re-run once resolved.`,
    "DIRTY_WORKTREE",
  );
}

/**
 * Remove a just-merged worktree and delete its branch, **verifying** both.
 *
 * Returns normally only when the directory is gone. Throws `REMOVE_FAILED`
 * otherwise, in which case the caller MUST NOT mark the row `merged`.
 *
 * ⛔ The branch is deleted only after the directory is confirmed gone. git
 * refuses to delete a branch still checked out in a worktree anyway, so
 * attempting it first would only add a second swallowed failure to the first.
 */
export function removeMergedWorktree(wt: Worktree, mergeCommit: string): void {
  const removal = gitExec(
    ["worktree", "remove", wt.worktreePath],
    wt.projectPath,
  );

  // Both halves matter: a non-zero exit is the normal signal, but `existsSync`
  // is what the invariant is actually about, and it also catches a git that
  // reported success while leaving something behind.
  if (removal.exitCode !== 0 || existsSync(wt.worktreePath)) {
    const dirty = gitVisibleChanges(wt.worktreePath);
    throw new WorktreeError(
      `The squash merge of ${wt.branchName} LANDED on ${wt.baseBranch} as ${mergeCommit}, ` +
        `but ${wt.worktreePath} could NOT be removed` +
        `${removal.stderr ? `: ${removal.stderr}` : "."} ` +
        `${dirty.length > 0 ? `It now holds ${listPaths(dirty)}. ` : ""}` +
        `⛔ Do NOT re-run the merge — it is already committed. This worktree has ` +
        `deliberately been left active rather than marked merged, because marking it ` +
        `merged would release its slot while the directory is still on disk and hand ` +
        `the next worktree the same ports and databases. ` +
        `Remedy: rescue anything you need from the directory, then run worktree_abandon ` +
        `on it — that path discards deliberately, and passes --force.`,
      "REMOVE_FAILED",
    );
  }

  gitExec(["branch", "-D", wt.branchName], wt.projectPath);
}
