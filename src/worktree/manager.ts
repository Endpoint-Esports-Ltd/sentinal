/**
 * Worktree Manager
 *
 * Business logic for git worktree lifecycle: create, diff, merge, abandon, cleanup.
 * Orchestrates git commands (via utils.ts) with SQLite persistence (via WorktreeStore).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorktreeStore } from "./store.js";
import {
  gitExec,
  gitExecOrThrow,
  getCurrentCommit,
  detectBaseBranch,
  getRepoRoot,
  checkGitVersion,
  slugify,
  randomHex,
  branchExists,
} from "../git/utils.js";
import {
  WorktreeError,
  DEFAULT_WORKTREE_CONFIG,
  type Worktree,
  type WorktreeConfig,
  type DiffSummary,
  type DiffFileSummary,
} from "./types.js";

// ─── Manager ────────────────────────────────────────────────────────────────

export class WorktreeManager {
  constructor(
    private store: WorktreeStore,
    private config: WorktreeConfig = DEFAULT_WORKTREE_CONFIG,
  ) {}

  /**
   * Create a new git worktree for a spec.
   * Creates a branch and worktree directory, records in SQLite.
   */
  create(
    specId: string | undefined,
    projectPath: string,
    baseBranch?: string,
  ): Worktree {
    // Check git version
    const versionCheck = checkGitVersion();
    if (!versionCheck.ok) {
      throw new WorktreeError(versionCheck.warning!, "GIT_TOO_OLD");
    }

    // Resolve repo root
    const repoRoot = getRepoRoot(projectPath);

    // Check max active limit
    const activeCount = this.store.countActive(repoRoot);
    if (activeCount >= this.config.maxActive) {
      throw new WorktreeError(
        `Maximum active worktrees (${this.config.maxActive}) reached. Merge or abandon existing worktrees first.`,
        "MAX_ACTIVE",
      );
    }

    // Detect base branch
    const base = baseBranch ?? detectBaseBranch(repoRoot);
    const baseCommit = getCurrentCommit(repoRoot);

    // Generate identifiers
    const slug = specId ? slugify(specId) : `worktree-${randomHex(4)}`;
    const hash = randomHex(4);
    const id = `${slug}-${hash}`;
    const branchName = `${this.config.branchPrefix}${slug}`;
    const worktreePath = join(
      repoRoot,
      this.config.directory,
      `spec-${slug}-${hash}`,
    );

    // Check if branch already exists
    if (branchExists(repoRoot, branchName)) {
      throw new WorktreeError(
        `Branch ${branchName} already exists. Abandon the existing worktree first.`,
        "ALREADY_EXISTS",
      );
    }

    // Create the worktree
    gitExecOrThrow(
      ["worktree", "add", "-b", branchName, worktreePath, base],
      repoRoot,
    );

    // Record in SQLite — always insert with spec_id=NULL to avoid FK constraint
    // failures when the spec hasn't been registered yet (normal workflow ordering).
    // Use linkSpec() after spec registration to set the spec_id.
    try {
      return this.store.insert({
        id,
        specId: undefined,
        projectPath: repoRoot,
        worktreePath,
        branchName,
        baseBranch: base,
        baseCommit,
        status: "active",
        createdAt: Date.now(),
      });
    } catch (err) {
      // Cleanup: remove the git worktree if DB insert fails
      gitExec(["worktree", "remove", "--force", worktreePath], repoRoot);
      throw err;
    }
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
   * Squash merge the worktree branch into the base branch.
   * Returns the merge commit hash.
   */
  squashMerge(worktreeId: string, message?: string): string {
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

    const commitMsg =
      message ?? `feat: ${wt.branchName.replace(this.config.branchPrefix, "")}`;

    // Checkout base branch in main project
    gitExecOrThrow(["checkout", wt.baseBranch], wt.projectPath);

    // Squash merge
    gitExecOrThrow(["merge", "--squash", wt.branchName], wt.projectPath);

    // Commit
    gitExecOrThrow(["commit", "-m", commitMsg], wt.projectPath);

    // Get merge commit hash
    const mergeCommit = getCurrentCommit(wt.projectPath);

    // Cleanup: remove worktree directory and delete branch
    gitExec(["worktree", "remove", wt.worktreePath], wt.projectPath);
    gitExec(["branch", "-D", wt.branchName], wt.projectPath);

    // Update store
    this.store.updateStatus(worktreeId, "merged", mergeCommit);

    return mergeCommit;
  }

  /** Abandon a worktree — remove from disk and mark as abandoned. */
  abandon(worktreeId: string): void {
    const wt = this.store.get(worktreeId);
    if (!wt)
      throw new WorktreeError(`Worktree ${worktreeId} not found`, "NOT_FOUND");

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
   * The on-disk state is authoritative:
   * - Index hit + directory exists → return it.
   * - Index hit + directory gone → mark abandoned, then try the disk scan.
   * - Index miss + git worktree on disk (e.g. the DB insert was lost to a
   *   transport failure, or the record was wrongly abandoned) → re-register
   *   it as active and return it.
   */
  resolveWithReconcile(slug: string, projectPath?: string): Worktree | null {
    const fromDb = this.store.resolveBySlug(slug, projectPath);
    if (fromDb) {
      if (existsSync(fromDb.worktreePath)) return fromDb;
      // Self-heal: directory gone — don't keep returning a dead record
      this.store.updateStatus(fromDb.id, "abandoned");
    }

    if (!projectPath) return null;

    let repoRoot: string;
    try {
      repoRoot = getRepoRoot(projectPath);
    } catch {
      return null;
    }

    // Disk scan: find a git worktree whose branch matches the slug
    const wanted = `${this.config.branchPrefix}${slugify(slug)}`;
    const onDisk = listGitWorktrees(repoRoot).find(
      (w) =>
        (w.branch === wanted || w.branch.startsWith(wanted)) &&
        existsSync(w.path),
    );
    if (!onDisk) return null;

    // Re-register: disk is authoritative
    const base = detectBaseBranch(repoRoot);
    const mergeBase = gitExec(["merge-base", base, onDisk.branch], repoRoot);
    const baseCommit =
      mergeBase.exitCode === 0 && mergeBase.stdout.trim()
        ? mergeBase.stdout.trim()
        : onDisk.head;

    return this.store.insert({
      id: `${slugify(slug)}-${randomHex(4)}`,
      specId: undefined,
      projectPath: repoRoot,
      worktreePath: onDisk.path,
      branchName: onDisk.branch,
      baseBranch: base,
      baseCommit,
      status: "active",
      createdAt: Date.now(),
    });
  }

  /**
   * Cleanup stale worktrees:
   * - Worktrees whose directory no longer exists on disk
   * - Worktrees for specs that are verified/cancelled
   * Returns count of cleaned up worktrees.
   */
  cleanup(): number {
    const active = this.store.listAll("active");
    let cleaned = 0;

    for (const wt of active) {
      let shouldClean = false;

      // Check if directory still exists
      if (!existsSync(wt.worktreePath)) {
        shouldClean = true;
      }

      if (shouldClean) {
        // Remove git worktree reference if still tracked
        gitExec(["worktree", "prune"], wt.projectPath);
        // Delete branch if it exists
        gitExec(["branch", "-D", wt.branchName], wt.projectPath);
        this.store.updateStatus(wt.id, "abandoned");
        cleaned++;
      }
    }

    return cleaned;
  }
}

// ─── Disk Scan ──────────────────────────────────────────────────────────────

interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

/**
 * Parse `git worktree list --porcelain` into entries.
 * Skips the main checkout and detached/bare entries (no branch line).
 */
function listGitWorktrees(repoRoot: string): GitWorktreeEntry[] {
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

// ─── Diff Parsing ───────────────────────────────────────────────────────────

/** Parse `git diff --numstat` output into a DiffSummary. */
function parseNumstat(output: string): DiffSummary {
  const files: DiffFileSummary[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of output.split("\n")) {
    // numstat lines: "10\t5\tsrc/file.ts" or "-\t-\tbinary-file"
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;

    const insertions = match[1] === "-" ? 0 : parseInt(match[1]);
    const deletions = match[2] === "-" ? 0 : parseInt(match[2]);
    const path = match[3];

    // Detect renamed files: "old => new" or "{old => new}/rest"
    const isRenamed = path.includes(" => ");
    let status: DiffFileSummary["status"];
    if (isRenamed) {
      status = "renamed";
    } else if (insertions > 0 && deletions === 0) {
      status = "added";
    } else if (insertions === 0 && deletions > 0) {
      status = "deleted";
    } else {
      status = "modified";
    }

    files.push({ path, status, insertions, deletions });
    totalInsertions += insertions;
    totalDeletions += deletions;
  }

  return {
    filesChanged: files.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    files,
  };
}
