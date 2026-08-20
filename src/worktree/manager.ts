/**
 * Worktree Manager
 *
 * Business logic for git worktree lifecycle: create, diff, merge, abandon, cleanup.
 * Orchestrates git commands (via utils.ts) with SQLite persistence (via WorktreeStore).
 */

import { existsSync, rmSync } from "node:fs";
import { WorktreeStore } from "./store.js";
import { parseNumstat } from "./diff-parse.js";
import {
  gitExec,
  gitExecOrThrow,
  getCurrentCommit,
  getRepoRoot,
} from "../git/utils.js";
import { createWorktree } from "./create.js";
import { cleanupWorktrees, type CleanupOptions } from "./cleanup.js";
import { resolveWithReconcile } from "./reconcile.js";
import { assertCleanForMerge, removeMergedWorktree } from "./merge-guards.js";
import {
  WorktreeError,
  DEFAULT_WORKTREE_CONFIG,
  type Worktree,
  type WorktreeConfig,
  type DiffSummary,
  type DiffFileSummary,
} from "./types.js";

// `CleanupOptions` moved to `cleanup.ts` with the pass it configures. Re-export
// so the manager's published surface is unchanged for existing importers.
export type { CleanupOptions } from "./cleanup.js";

// ─── Manager ────────────────────────────────────────────────────────────────

export class WorktreeManager {
  constructor(
    private store: WorktreeStore,
    private config: WorktreeConfig = DEFAULT_WORKTREE_CONFIG,
  ) {}

  /**
   * Create a new git worktree for a spec. Delegates to {@link createWorktree}
   * in `create.ts`, which carries the rollback envelope.
   *
   * @param warnings - optional collector for non-fatal problems raised while
   *   seeding config (missing `.env.example`, a non-isolated seed source, a
   *   file that could not be hidden from git). Callers that surface output to a
   *   human or an LLM should pass one — a silently unseeded worktree is what
   *   sends an agent back to copying the repo-root `.env`.
   */
  create(
    specId: string | undefined,
    projectPath: string,
    baseBranch?: string,
    warnings?: string[],
  ): Worktree {
    return createWorktree(
      this.store,
      this.config,
      specId,
      projectPath,
      baseBranch,
      warnings,
    );
  }

  /**
   * Link a spec ID to an existing worktree.
   * Call this after registering the spec via spec_register to satisfy the FK constraint.
   */
  linkSpec(worktreeId: string, specId: string): void {
    const wt = this.store.get(worktreeId);
    if (!wt) {
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");
    }
    this.store.updateSpecId(worktreeId, specId);
  }

  /** List worktrees, optionally filtered by project. */
  list(projectPath?: string): Worktree[] {
    if (projectPath) {
      const repoRoot = getRepoRoot(projectPath);
      return this.store.listForProject(repoRoot);
    }
    return this.store.listAll();
  }

  /** Get detailed status of a worktree, verifying it still exists on disk. */
  status(
    worktreeId: string,
  ): Worktree & { existsOnDisk: boolean; diffSummary?: DiffSummary } {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

    const onDisk = existsSync(wt.worktreePath);
    let diffSummary: DiffSummary | undefined;

    if (onDisk && wt.status === "active") {
      try {
        diffSummary = this.diff(worktreeId);
      } catch {
        // Diff may fail if branch state is unusual
      }
    }

    return { ...wt, existsOnDisk: onDisk, diffSummary };
  }

  /** Get diff summary between worktree branch and base branch. */
  diff(worktreeId: string): DiffSummary {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

    const result = gitExec(
      ["diff", "--stat", "--numstat", `${wt.baseBranch}...${wt.branchName}`],
      wt.projectPath,
    );

    if (result.exitCode !== 0) {
      return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
    }

    return parseNumstat(result.stdout);
  }

  /** Check if merging the worktree branch would produce conflicts. */
  hasConflicts(worktreeId: string): boolean {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

    // Use merge-tree to do a dry-run merge
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
   * Stop the process group this worktree owns, before anything touches its
   * directory. Throws `RUNTIME_STOP_FAILED` if the stop refused or failed.
   *
   * ⛔ **Fast no-op** in the case that matters: `stopOwnedGroup` short-circuits
   * on an absent pidfile *before* it loads the runtime contract, so a worktree
   * that never started a runtime never runs `down` and never pays `graceMs`
   * (Pre-Mortem #2 — `abandon` is called on every worktree, not just the ones
   * that ran something).
   *
   * ⛔ A failed stop **aborts the exit path**. `stopOwnedGroup` reports
   * `ok: false` exactly when it could not prove ownership or could not signal;
   * removing the directory anyway would orphan a live process with its cwd
   * deleted, which is precisely the failure this phase exists to prevent. The
   * caller gets an actionable message naming what to do by hand.
   *
   * ⛔ An **absent** resolver aborts it too. This used to `return` early, which
   * made "nobody wired the dep" behave identically to "there is nothing to
   * stop" — the one decision in this tier that failed OPEN, guarded only by a
   * grep over five known construction sites. `stopOwnedRuntime` is now required
   * on `WorktreeConfig`, so omission is a compile error; this branch catches the
   * JS caller and the `as any` that tsc never sees. A deliberate opt-out is
   * spelled {@link NO_RUNTIME_STOP}, which is a real function and never lands
   * here.
   */
  private async stopOwnedRuntime(wt: Worktree): Promise<void> {
    const stop = this.config.stopOwnedRuntime;
    if (!stop) {
      throw new WorktreeError(
        `Refusing to remove ${wt.worktreePath}: this WorktreeManager was built with no ` +
          `\`stopOwnedRuntime\` resolver, so Sentinal cannot tell whether the worktree owns ` +
          `running processes. Removing the directory now could orphan a live process with a ` +
          `deleted working directory. ` +
          `Remedy: construct the manager via runtimeWorktreeConfig() (src/runtime/worktree-deps.ts), ` +
          `or — if this manager genuinely owns no runtime — declare that by setting ` +
          `stopOwnedRuntime: NO_RUNTIME_STOP.`,
        "RUNTIME_STOP_FAILED",
      );
    }

    const outcome = await stop(wt.worktreePath);
    if (outcome.ok) return;

    throw new WorktreeError(
      `Refusing to remove ${wt.worktreePath}: the runtime it owns could not be stopped. ` +
        `${outcome.reason ?? "No reason was given."} ` +
        `Removing the directory now would leave a live process with a deleted working ` +
        `directory — resolve this first, then retry.`,
      "RUNTIME_STOP_FAILED",
    );
  }

  /**
   * Squash merge the worktree branch into the base branch.
   * Returns the merge commit hash.
   */
  async squashMerge(worktreeId: string, message?: string): Promise<string> {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

    if (wt.status !== "active" && wt.status !== "ready-to-merge") {
      throw new WorktreeError(
        `Worktree ${worktreeId} is ${wt.status}, cannot merge`,
        "GIT_ERROR",
      );
    }

    // Check for conflicts first
    if (this.hasConflicts(worktreeId)) {
      throw new WorktreeError(
        `Worktree ${worktreeId} has merge conflicts with ${wt.baseBranch}. Resolve conflicts manually.`,
        "CONFLICT",
      );
    }

    // ⛔ Refuse a worktree git will not let us remove, BEFORE anything is done.
    // The alternative outcomes are both bad: `--force` would silently discard
    // untracked work the squash never carried across, and swallowing the
    // refusal (the old behaviour) marked the row `merged` — terminal, so its
    // slot was released — while the directory stayed on disk. See
    // `merge-guards.ts` for the full argument.
    assertCleanForMerge(wt);

    const commitMsg =
      message ?? `feat: ${wt.branchName.replace(this.config.branchPrefix, "")}`;

    // ⛔ Stop BEFORE `git checkout`, not merely before `worktree remove`. A live
    // process holding files under the worktree can make the checkout itself
    // fail, which would leave the main checkout on the wrong branch with the
    // merge half-done — a worse state than not having started.
    await this.stopOwnedRuntime(wt);

    // Checkout base branch in main project
    gitExecOrThrow(["checkout", wt.baseBranch], wt.projectPath);

    // Squash merge
    gitExecOrThrow(["merge", "--squash", wt.branchName], wt.projectPath);

    // Commit
    gitExecOrThrow(["commit", "-m", commitMsg], wt.projectPath);

    // Get merge commit hash
    const mergeCommit = getCurrentCommit(wt.projectPath);

    // Cleanup: remove the worktree directory and delete the branch — and THROW
    // if the directory survives. The preflight cannot see a file created since,
    // and `merged` must never be written over a directory that is still there:
    // it is terminal, so it frees the slot for a worktree that would then
    // collide with this one's ports, databases and seeded `.env`.
    removeMergedWorktree(wt, mergeCommit);

    // Update store — reached only once the directory is gone.
    this.store.updateStatus(worktreeId, "merged", mergeCommit);

    return mergeCommit;
  }

  /** Abandon a worktree — remove from disk and mark as abandoned. */
  async abandon(worktreeId: string): Promise<void> {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

    // ⛔ Before the directory is touched at all — including the `rmSync`
    // fallback below, which git cannot veto.
    await this.stopOwnedRuntime(wt);

    // Remove worktree from disk (force in case of uncommitted changes)
    if (existsSync(wt.worktreePath)) {
      const result = gitExec(
        ["worktree", "remove", "--force", wt.worktreePath],
        wt.projectPath,
      );
      if (result.exitCode !== 0) {
        // Fallback: remove directory manually and prune
        try {
          rmSync(wt.worktreePath, { recursive: true, force: true });
          gitExec(["worktree", "prune"], wt.projectPath);
        } catch {
          // Best effort
        }
      }
    }

    // Delete the branch
    gitExec(["branch", "-D", wt.branchName], wt.projectPath);

    // Update store
    this.store.updateStatus(worktreeId, "abandoned");
  }

  /**
   * Resolve a plan slug to a worktree, reconciling against the filesystem.
   * Delegates to {@link resolveWithReconcile} in `reconcile.ts`.
   */
  resolveWithReconcile(
    slug: string,
    projectPath?: string,
    warnings?: string[],
  ): Worktree | null {
    return resolveWithReconcile(
      this.store,
      this.config,
      slug,
      projectPath,
      warnings,
    );
  }

  /**
   * Cleanup stale worktrees (directory-gone pass, plus the opt-in `force` pass
   * over orphans whose directory still exists). Delegates to
   * {@link cleanupWorktrees} in `cleanup.ts`.
   */
  cleanup(opts?: CleanupOptions): number {
    return cleanupWorktrees(this.store, this.config, opts);
  }
}
