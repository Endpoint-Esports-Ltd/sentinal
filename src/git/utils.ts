/**
 * Git Utility Functions
 *
 * Helper functions for git operations used by the worktree system.
 * All commands use Bun.spawnSync for synchronous execution.
 */

import { WorktreeError } from "../worktree/types.js";

// ─── Git Command Execution ──────────────────────────────────────────────────

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Execute a git command and return stdout/stderr/exitCode. */
export function gitExec(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout?.toString().trim() ?? "",
    stderr: result.stderr?.toString().trim() ?? "",
    exitCode: result.exitCode,
  };
}

/** Execute a git command, throwing WorktreeError on failure. */
export function gitExecOrThrow(args: string[], cwd: string): string {
  const result = gitExec(args, cwd);
  if (result.exitCode !== 0) {
    throw new WorktreeError(
      `git ${args[0]} failed: ${result.stderr || result.stdout}`,
      "GIT_ERROR",
    );
  }
  return result.stdout;
}

// ─── Branch Operations ──────────────────────────────────────────────────────

/** Get the current branch name. Returns "HEAD" if in detached HEAD state. */
export function getCurrentBranch(cwd: string): string {
  const result = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.exitCode !== 0) {
    throw new WorktreeError("Not a git repository", "NOT_A_REPO");
  }
  return result.stdout;
}

/** Check if a branch exists locally. */
export function branchExists(cwd: string, branch: string): boolean {
  const result = gitExec(
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    cwd,
  );
  return result.exitCode === 0;
}

/**
 * Detect the base branch for the repository.
 * Checks origin/HEAD, then main, master, develop in order.
 * Falls back to current branch.
 */
export function detectBaseBranch(cwd: string): string {
  // Try origin/HEAD first
  const originHead = gitExec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (originHead.exitCode === 0) {
    // Returns e.g. "refs/remotes/origin/main"
    const parts = originHead.stdout.split("/");
    return parts[parts.length - 1];
  }

  // Check common branch names
  const candidates = ["main", "master", "develop"];
  for (const branch of candidates) {
    if (branchExists(cwd, branch)) return branch;
  }

  // Fall back to current branch
  return getCurrentBranch(cwd);
}

// ─── Repository Info ────────────────────────────────────────────────────────

/** Get the root directory of the git repository. */
export function getRepoRoot(cwd: string): string {
  const result = gitExec(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) {
    throw new WorktreeError("Not a git repository", "NOT_A_REPO");
  }
  return result.stdout;
}

/** Get the current HEAD commit hash. */
export function getCurrentCommit(cwd: string): string {
  return gitExecOrThrow(["rev-parse", "HEAD"], cwd);
}

/** Parse the git version string into [major, minor, patch]. */
export function getGitVersion(): [number, number, number] {
  const result = Bun.spawnSync(["git", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new WorktreeError("git not found on PATH", "GIT_ERROR");
  }
  const output = result.stdout?.toString().trim() ?? "";
  // "git version 2.39.3 (Apple Git-146)" → "2.39.3"
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new WorktreeError(
      `Could not parse git version: ${output}`,
      "GIT_ERROR",
    );
  }
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

/**
 * Check git version meets minimum requirements.
 * - >= 2.17 required for `git worktree remove`
 * - >= 2.5 minimum for `git worktree` at all
 */
export function checkGitVersion(): {
  ok: boolean;
  version: string;
  warning?: string;
} {
  const [major, minor, patch] = getGitVersion();
  const version = `${major}.${minor}.${patch}`;

  if (major < 2 || (major === 2 && minor < 5)) {
    return {
      ok: false,
      version,
      warning: `Git ${version} is too old. git worktree requires Git 2.5+.`,
    };
  }
  if (major === 2 && minor < 17) {
    return {
      ok: true,
      version,
      warning: `Git ${version} detected. Git 2.17+ recommended for full worktree support (git worktree remove).`,
    };
  }
  return { ok: true, version };
}

// ─── Slug Utilities ─────────────────────────────────────────────────────────

/**
 * Convert a string to a branch-safe slug.
 * Removes special chars, replaces spaces/underscores with hyphens,
 * lowercases, and truncates to maxLength.
 */
export function slugify(input: string, maxLength: number = 50): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "") // Remove special chars
    .replace(/[\s_]+/g, "-") // Spaces/underscores → hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
    .slice(0, maxLength);
}

/** Generate a short random hex string for uniqueness. */
export function randomHex(bytes: number = 4): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
