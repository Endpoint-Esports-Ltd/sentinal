/**
 * Worktree cleanup — the default (directory-gone) pass and the opt-in `force`
 * pass over orphans whose directory still exists.
 *
 * Extracted verbatim from `manager.ts`, which sat at 582/600 lines with Phase 4
 * still to land on it (same precedent as `diff-parse.ts` and `disk-scan.ts`).
 * `WorktreeManager.cleanup()` is now a delegating one-liner; `CleanupOptions`
 * is re-exported from `manager.ts` so no existing import path breaks.
 */

import { existsSync, rmSync } from "node:fs";
import { WorktreeStore } from "./store.js";
import { listGitWorktrees, resolveRealPath, isInside } from "./disk-scan.js";
import { gitExec, getRepoRoot } from "../git/utils.js";
import type { WorktreeConfig, RuntimeLiveVerdict } from "./types.js";

/** Options for {@link cleanupWorktrees} / `WorktreeManager.cleanup`. */
export interface CleanupOptions {
  /**
   * Opt-in: also remove ORPHANED sentinal worktrees whose directory still
   * exists (crashed/abandoned sessions). Off by default — without this the
   * cleanup only removes worktrees whose directory is already gone.
   */
  force?: boolean;
  /**
   * The project to scope the `force` pass to. REQUIRED for `force`. Must be the
   * real caller's project — never the sidecar's process.cwd().
   */
  projectPath?: string;
  /**
   * The caller's current worktree directory, if any. Never removed. Must be
   * threaded from the real caller (not the sidecar cwd).
   */
  currentWorktree?: string;
  /**
   * Predicate: does the plan for this slug have an active (IN_PROGRESS) spec?
   * Returning true excludes that worktree from `force` removal. Defaults to
   * "never active" — callers wanting the guard MUST supply a real resolver.
   */
  isPlanActive?: (slug: string) => boolean;
  /**
   * Guard 5: does this worktree still own running processes? Overrides
   * `WorktreeConfig.ownsLiveRuntime` when supplied (tests and callers that
   * already hold a verdict); production supplies it via the manager's config,
   * because the answer is derived **server-side** from the worktree's own
   * pidfile. ⛔ There is deliberately no wire field for it: a caller-supplied
   * "nothing is running" would be a caller-supplied licence to delete.
   *
   * ⛔ **No default.** When neither this nor `WorktreeConfig.ownsLiveRuntime`
   * is supplied the entire `force` pass is REFUSED and a warning is pushed —
   * the guard fails closed. A permissive default would let any construction
   * site that forgets the resolver delete directories with no running-process
   * check, silently, with nothing going red.
   */
  ownsLiveRuntime?: (worktreePath: string) => RuntimeLiveVerdict;
  /**
   * Collector for worktrees that were **skipped** and why. ⛔ Pass one. A
   * cleanup that silently removes nothing reads as "there was nothing to do",
   * and the obvious next move for an agent reading `Cleaned up 0 worktrees.` is
   * to delete the directory by hand — the exact orphan guard 5 just prevented.
   */
  warnings?: string[];
}

/**
 * Cleanup stale worktrees:
 * - Worktrees whose directory no longer exists on disk
 * - Worktrees for specs that are verified/cancelled
 * Returns count of cleaned up worktrees.
 */
export function cleanupWorktrees(
  store: WorktreeStore,
  config: WorktreeConfig,
  opts?: CleanupOptions,
): number {
  let cleaned = 0;

  // ── Default pass: worktrees whose directory no longer exists ──────────────
  // Runs regardless of `force`. Scoped to the caller's project when one was
  // given (M3b): `listAll` spans EVERY project Sentinal has ever tracked, and
  // this pass runs `git branch -D` in each row's own repo — a cleanup asked
  // for project A must not delete branches in project B. An UNSCOPED call
  // keeps the historical global sweep.
  let scope: string | null = null;
  if (opts?.projectPath) {
    try {
      scope = getRepoRoot(opts.projectPath);
    } catch {
      // Not a git repo — fall back to the raw path (rows store the repo root,
      // so a non-repo path simply matches nothing rather than everything).
      scope = opts.projectPath;
    }
  }
  const candidates = scope
    ? store.listForProject(scope, "active")
    : store.listAll("active");
  for (const wt of candidates) {
    if (existsSync(wt.worktreePath)) continue;
    // Remove git worktree reference if still tracked
    gitExec(["worktree", "prune"], wt.projectPath);
    // Delete branch if it exists
    gitExec(["branch", "-D", wt.branchName], wt.projectPath);
    store.updateStatus(wt.id, "abandoned");
    cleaned++;
  }

  // ── Opt-in `force` pass: orphaned worktrees whose directory STILL EXISTS ──
  // Reconciles `git worktree list` against the DB and removes stale sentinal
  // worktrees left by crashed/abandoned sessions. Heavily guarded to NEVER
  // delete an in-use, in-progress, or non-sentinal worktree.
  if (opts?.force && opts.projectPath) {
    cleaned += forceCleanupOrphans(store, config, opts.projectPath, opts);
  }

  return cleaned;
}

/**
 * Remove stale sentinal-owned worktrees in `projectPath` whose directory
 * still exists. Five independent safety guards prevent over-deletion:
 *   1. only branches matching the sentinal prefix (`config.branchPrefix`),
 *   2. only paths inside `projectPath`,
 *   3. never the caller's `currentWorktree`,
 *   4. never a worktree whose plan is IN_PROGRESS (`isPlanActive`),
 *   5. never a worktree that still owns live processes (`ownsLiveRuntime`).
 *
 * ⛔ Guard 5 runs **last** on purpose. It is the only guard that shells out
 * (`ps`, `lsof`), so a candidate already excluded by a cheaper guard must not
 * pay for it. Its verdict is also the only one that is deliberately biased
 * *against* the caller's request: anything it cannot rule out counts as live,
 * because a wrong "nothing is running" costs an orphaned process whose working
 * directory has just been deleted, while a wrong "something is running" costs
 * one skipped cleanup and a warning.
 */
function forceCleanupOrphans(
  store: WorktreeStore,
  config: WorktreeConfig,
  projectPath: string,
  opts: CleanupOptions,
): number {
  const repoRoot = getRepoRoot(projectPath);
  const prefix = config.branchPrefix; // e.g. "sentinal/spec-"
  const current = opts.currentWorktree
    ? resolveRealPath(opts.currentWorktree)
    : null;
  const isPlanActive = opts.isPlanActive ?? (() => false);
  const warnings = opts.warnings;

  // ⛔ Guard 5 fails CLOSED. Option beats config; absent BOTH, the entire
  // `force` pass is refused rather than run with the guard silently disabled.
  //
  // A permissive default is the same defect class as the guard-3 gap this
  // phase fixed: a construction site that forgets the resolver disables the
  // check with nothing going red, and `--force` then deletes directories with
  // no running-process test at all. The backward-compatibility argument for a
  // permissive default is weaker than it looks — the default only ever applies
  // to `force: true`, which is already opt-in and DESTRUCTIVE, and the cost of
  // refusing is one skipped cleanup while the cost of proceeding is a live
  // process whose working directory has just been deleted.
  const ownsLiveRuntime = opts.ownsLiveRuntime ?? config.ownsLiveRuntime;
  if (!ownsLiveRuntime) {
    warnings?.push(
      `Force cleanup was REFUSED for ${projectPath}: no liveness resolver was supplied, so ` +
        `guard 5 ("never remove a worktree that still owns running processes") cannot be ` +
        `evaluated. Refusing to delete worktree directories without a running-process check. ` +
        `This is a wiring bug — the manager must be constructed with ` +
        `\`runtimeWorktreeConfig()\` (src/runtime/worktree-deps.ts), or the caller must pass ` +
        `\`ownsLiveRuntime\` explicitly. Worktrees whose directory is already gone were still ` +
        `cleaned up by the default pass.`,
    );
    return 0;
  }

  let cleaned = 0;

  for (const gwt of listGitWorktrees(repoRoot)) {
    // Guard 1: only sentinal-owned branches.
    if (!gwt.branch.startsWith(prefix)) continue;
    // Guard 2: only worktrees inside the target project.
    if (!isInside(gwt.path, repoRoot)) continue;
    // Guard 3: never the caller's current worktree — including when the
    // caller stands in a SUBDIRECTORY of it (M3a). Exact equality alone left
    // a caller at `<worktree>/src` unprotected from `--force` deleting the
    // directory under their feet. `isInside` is strictly-inside and handles
    // the `<parent>-evil` sibling separator case — reuse it, don't reimplement.
    if (
      current &&
      (resolveRealPath(gwt.path) === current || isInside(current, gwt.path))
    )
      continue;

    const slug = gwt.branch.slice(prefix.length);
    // Guard 4: never an in-progress plan.
    if (isPlanActive(slug)) continue;

    // Guard 5: never a worktree that still owns live processes.
    const live = ownsLiveRuntime(gwt.path);
    if (live.live) {
      warnings?.push(
        `Skipped ${gwt.path}: ${live.detail ?? "it may still own running processes."}`,
      );
      continue;
    }

    // Remove the worktree fully. Best-effort per entry — one failure must not
    // abort the whole pass.
    const removed = gitExec(
      ["worktree", "remove", "--force", gwt.path],
      repoRoot,
    );
    if (removed.exitCode !== 0) {
      try {
        rmSync(gwt.path, { recursive: true, force: true });
        gitExec(["worktree", "prune"], repoRoot);
      } catch {
        continue; // could not remove — skip, do not count
      }
    }
    gitExec(["branch", "-D", gwt.branch], repoRoot);

    // Reconcile the DB: mark the record abandoned if one exists (class 1);
    // no-op for git-only orphans (class 2).
    const rec = store.resolveBySlug(slug, repoRoot);
    if (rec) store.updateStatus(rec.id, "abandoned");

    cleaned++;
  }

  return cleaned;
}
