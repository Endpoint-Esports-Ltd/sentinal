/**
 * Worktree Manager
 *
 * Business logic for git worktree lifecycle: create, diff, merge, abandon, cleanup.
 * Orchestrates git commands (via utils.ts) with SQLite persistence (via WorktreeStore).
 */

import { existsSync } from "node:fs";
import { WorktreeStore } from "./store.js";
import { parseNumstat } from "./diff-parse.js";
import { gitExec } from "../git/utils.js";
import { resolveProjectIdentity } from "../project/identity.js";
import {
  createWorktree,
  runSetupNonFatally,
  type WorktreeSetupOutcome,
} from "./create.js";
import { cleanupWorktrees } from "./cleanup.js";
import type { CleanupOptions, CleanupResult } from "./cleanup.js";
import { resolveWithReconcile } from "./reconcile.js";
import { abandonWorktree } from "./abandon.js";
import type { AbandonResult } from "./abandon.js";
import {
  hasMergeConflicts,
  squashMergeWorktree,
  type MergeResult,
} from "./merge.js";
import {
  WorktreeError,
  DEFAULT_WORKTREE_CONFIG,
  type Worktree,
  type WorktreeConfig,
  type DiffSummary,
} from "./types.js";

// `CleanupOptions` moved to `cleanup.ts` with the pass it configures. Re-export
// so the manager's published surface is unchanged for existing importers.
export type { CleanupOptions } from "./cleanup.js";
export type { AbandonResult } from "./abandon.js";
export type { MergeResult } from "./merge.js";

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
   * @param warnings - optional collector for non-fatal seeding problems; see
   *   {@link createWorktree}. Callers surfacing output should pass one.
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
   * {@link create}, then the injected `config.runSetup` (orca D5) — outside the
   * rollback, so a setup failure is a warning and the worktree stays. What the
   * `worktree_create` tool calls; `create` stays synchronous for its callers.
   * Goes through `this.create` (not `createWorktreeWithSetup`) so it is the
   * same code path — and the same seam — as a plain create.
   */
  async createWithSetup(
    specId: string | undefined,
    projectPath: string,
    baseBranch?: string,
    warnings?: string[],
  ): Promise<{ worktree: Worktree; setup?: WorktreeSetupOutcome }> {
    const worktree = this.create(specId, projectPath, baseBranch, warnings);
    const runSetup = this.config.runSetup;
    if (!runSetup) return { worktree };
    return {
      worktree,
      setup: await runSetupNonFatally(runSetup, worktree, warnings),
    };
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

  /** List worktrees, optionally filtered by (canonical, Task 13) project. */
  list(projectPath?: string): Worktree[] {
    if (projectPath) {
      return this.store.listForProject(resolveProjectIdentity(projectPath));
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
    return hasMergeConflicts(wt);
  }

  /**
   * Squash merge the worktree branch into the base branch; returns the merge
   * commit hash. Back-compat wrapper over {@link squashMergeDetailed}.
   */
  async squashMerge(
    worktreeId: string,
    message?: string,
    warnings?: string[],
  ): Promise<string> {
    return (await this.squashMergeDetailed(worktreeId, message, warnings))
      .commit;
  }

  /**
   * Squash merge, reporting which checkout received the commit (D3) and
   * whether the worktree was removed or — external — released (D2).
   * Delegates to {@link squashMergeWorktree} in `merge.ts`.
   *
   * @param warnings - optional collector for non-fatal notes (detached HEAD,
   *   a branch restore that itself failed). Same channel as {@link create}.
   */
  squashMergeDetailed(
    worktreeId: string,
    message?: string,
    warnings?: string[],
  ): Promise<MergeResult> {
    return squashMergeWorktree(
      this.store,
      this.config,
      worktreeId,
      message,
      warnings,
    );
  }

  /**
   * Abandon a worktree. Sentinal-owned → removed with its branch; external →
   * RELEASED, left in place (D2). Delegates to {@link abandonWorktree}.
   */
  abandon(worktreeId: string): Promise<AbandonResult> {
    return abandonWorktree(this.store, this.config, worktreeId);
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
   * {@link cleanupWorktrees} in `cleanup.ts`. Returns the count AND what was
   * removed ({@link CleanupResult}) — a bare count is not reconcilable after
   * an ambiguous transport failure (issue #9).
   */
  cleanup(opts?: CleanupOptions): CleanupResult {
    return cleanupWorktrees(this.store, this.config, opts);
  }
}
