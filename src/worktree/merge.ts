/**
 * Squash-merge a worktree back into its base branch. Moved from `manager.ts`
 * (orca-orchestration Task 7), which delegates here.
 *
 * - **Where (D3).** In the checkout that already holds the base branch, if one
 *   can receive the merge (an Orca coordinator's linked worktree, typically);
 *   otherwise the main checkout, as before — {@link resolveMergeCheckout}. That
 *   checkout must be clean for tracked files, and is put back on the branch it
 *   was on (H3; a holder is already on the base, so that is a no-op).
 * - **Sentinal-owned.** Unchanged: remove the directory, delete the branch,
 *   and only then mark `merged` — never over a directory that survived.
 * - **External (D2).** Commit as usual, then strip only Sentinal's seeded files
 *   and mark `merged` (frees the slot). ⛔ Never `git worktree remove` nor
 *   `git branch -D`: another tool owns that directory and branch.
 *
 * ⛔ Must import NOTHING from `src/runtime/` — see
 * `src/runtime/no-module-cycle.test.ts`.
 */

import { existsSync } from "node:fs";
import { gitExec, gitExecOrThrow, getCurrentCommit } from "../git/utils.js";
import { stopOwnedRuntime, stripSeededFiles } from "./abandon.js";
import {
  assertCleanForMerge,
  assertMainCheckoutCleanForMerge,
  assertBaseFreeForMerge,
  inMainCheckout,
  removeMergedWorktree,
  resolveMergeCheckout,
} from "./merge-guards.js";
import type { WorktreeStore } from "./store.js";
import { WorktreeError, type Worktree, type WorktreeConfig } from "./types.js";

/** What a squash merge did. */
export interface MergeResult {
  /** The squash commit on the base branch. */
  commit: string;
  /** The checkout that received the commit (D3) — main or the base's holder. */
  mergedIn: string;
  /** `removed`: directory + branch deleted. `released`: external, left in place. */
  outcome: "removed" | "released";
}

/** Dry-run merge: would squashing `wt.branchName` onto its base conflict? */
export function hasMergeConflicts(wt: Worktree): boolean {
  const mergeBase = gitExec(
    ["merge-base", wt.baseBranch, wt.branchName],
    wt.projectPath,
  );
  if (mergeBase.exitCode !== 0) return true;

  const result = gitExec(
    ["merge-tree", mergeBase.stdout, wt.baseBranch, wt.branchName],
    wt.projectPath,
  );
  // merge-tree outputs conflict markers when there are conflicts
  return result.stdout.includes("<<<<<<");
}

/**
 * Squash merge the worktree branch into the base branch.
 *
 * @param warnings - optional collector for non-fatal notes (detached HEAD, a
 *   branch restore that itself failed, seeded files left in an external tree).
 */
export async function squashMergeWorktree(
  store: WorktreeStore,
  config: WorktreeConfig,
  worktreeId: string,
  message?: string,
  warnings?: string[],
): Promise<MergeResult> {
  const row = store.get(worktreeId);
  if (!row)
    throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");
  // D5: git bookkeeping (removal, branch delete) runs in the MAIN checkout,
  // even for a legacy linked-keyed row.
  const wt = inMainCheckout(row);

  if (wt.status !== "active" && wt.status !== "ready-to-merge") {
    throw new WorktreeError(
      `Worktree ${worktreeId} is ${wt.status}, cannot merge`,
      "GIT_ERROR",
    );
  }

  if (hasMergeConflicts(wt)) {
    throw new WorktreeError(
      `Worktree ${worktreeId} has merge conflicts with ${wt.baseBranch}. Resolve conflicts manually.`,
      "CONFLICT",
    );
  }

  // ⛔ Refuse a worktree git will not let us remove, BEFORE anything is done —
  // see `merge-guards.ts`. (External trees are not removed, but uncommitted
  // work there would still silently miss the squash, so the refusal stands.)
  assertCleanForMerge(wt);

  // D3: where the checkout + commit run.
  const checkout = resolveMergeCheckout(wt);
  // ⛔ H3: staged/modified tracked work in THAT checkout would be swept into
  // the squash commit. Untracked files are allowed.
  assertMainCheckoutCleanForMerge(wt, checkout);
  // A base held somewhere that cannot receive the merge.
  assertBaseFreeForMerge(wt, checkout);

  const commitMsg =
    message ?? `feat: ${wt.branchName.replace(config.branchPrefix, "")}`;

  // ⛔ Stop BEFORE `git checkout`: a live process holding files under the
  // worktree can make the checkout itself fail mid-merge.
  await stopOwnedRuntime(config, wt);

  // H3: remember where the checkout was. Empty string = detached HEAD.
  const originalBranch = gitExec(["branch", "--show-current"], checkout).stdout;
  if (!originalBranch) {
    warnings?.push(
      `The checkout at ${checkout} was on a detached HEAD before the merge; it has been ` +
        `left on ${wt.baseBranch}. Re-detach manually if you need that state back.`,
    );
  }

  let checkedOut = false;
  try {
    gitExecOrThrow(["checkout", wt.baseBranch], checkout);
    checkedOut = true;
    gitExecOrThrow(["merge", "--squash", wt.branchName], checkout);
    gitExecOrThrow(["commit", "-m", commitMsg], checkout);
    const commit = getCurrentCommit(checkout);

    if (wt.owner === "external") {
      // D2: the directory and branch belong to another tool — leave them.
      if (existsSync(wt.worktreePath)) {
        warnings?.push(...stripSeededFiles(config, wt));
      }
      store.updateStatus(worktreeId, "merged", commit);
      return { commit, mergedIn: checkout, outcome: "released" };
    }

    // Remove the directory and delete the branch — THROWS if the directory
    // survives, so `merged` (terminal; frees the slot) is never written over a
    // directory still on disk.
    removeMergedWorktree(wt, commit);
    store.updateStatus(worktreeId, "merged", commit);
    return { commit, mergedIn: checkout, outcome: "removed" };
  } finally {
    // H3: restore the checkout's branch — on success AND on any failure after
    // the checkout moved HEAD. Best-effort: never mask the real error.
    if (checkedOut && originalBranch && originalBranch !== wt.baseBranch) {
      const restore = gitExec(["checkout", originalBranch], checkout);
      if (restore.exitCode !== 0) {
        warnings?.push(
          `Could not restore the checkout at ${checkout} to ${originalBranch} ` +
            `(it is on ${wt.baseBranch}): ${restore.stderr || restore.stdout}`,
        );
      }
    }
  }
}
