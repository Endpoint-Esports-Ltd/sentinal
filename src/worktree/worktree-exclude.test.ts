/**
 * SPIKE (Phase 2, Task 1) — how do we hide Sentinal-written files from git
 * inside a LINKED worktree without touching the developer's main checkout?
 *
 * This file is deliberately a *probe*, not a unit test of our own code: it
 * asserts observable git behaviour so the choice of exclusion mechanism is
 * evidence-based and stays honest if git changes.
 *
 * Findings are recorded in
 * `docs/plans/2026-08-07-worktree-runtime-isolation-phase-2.md` → "Spike Findings".
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): { out: string; code: number } {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  return {
    out: new TextDecoder().decode(r.stdout).trim(),
    code: r.exitCode ?? 1,
  };
}

function initRepo(dir: string, opts?: { gitignore?: string }): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  if (opts?.gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), opts.gitignore);
  }
  git(["add", "."], dir);
  git(["commit", "-m", "initial commit"], dir);
}

/** true when `rel` is ignored inside `cwd`. */
function isIgnored(cwd: string, rel: string): boolean {
  return git(["check-ignore", "-q", "--", rel], cwd).code === 0;
}

/** true when `rel` is tracked in this worktree's index. */
function isTracked(cwd: string, rel: string): boolean {
  return git(["ls-files", "--error-unmatch", "--", rel], cwd).code === 0;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("SPIKE: excluding Sentinal-written files inside a linked worktree", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtDir: string;

  function setup(gitignore?: string): void {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    wtDir = join(tmpDir, "wt");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir, { gitignore });
    git(["worktree", "add", wtDir, "-b", "feat"], repoDir);
  }

  beforeEach(() => {
    setup();
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Prove the setup is a real linked worktree ────────────────────────

  it("a linked worktree's --git-dir differs from its --git-common-dir", () => {
    const gitDir = git(["rev-parse", "--absolute-git-dir"], wtDir).out;
    const commonDir = git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      wtDir,
    ).out;

    expect(gitDir).not.toBe(commonDir);
    // The per-worktree gitdir lives *under* the common dir, at worktrees/<name>
    expect(gitDir).toContain("worktrees");
    expect(gitDir.startsWith(commonDir)).toBe(true);
    // And `.git` in the worktree is a FILE, not a directory
    expect(readFileSync(join(wtDir, ".git"), "utf-8")).toStartWith("gitdir:");
  });

  // ── 2. NEGATIVE RESULT: the preferred candidate does not work ───────────

  it("REJECTED (a): `git rev-parse --git-path info/exclude` resolves into the MAIN checkout", () => {
    const resolved = git(
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      wtDir,
    ).out;
    const mainExclude = realpathSync(join(repoDir, ".git"));

    // Git deliberately routes info/ through the common dir. A naive
    // "resolve the gitdir properly, then write info/exclude" implementation
    // therefore writes into the DEVELOPER'S MAIN CHECKOUT.
    expect(resolved).toBe(join(mainExclude, "info", "exclude"));
    expect(resolved).not.toContain("worktrees");
  });

  it("REJECTED (b): a pattern written to <per-worktree gitdir>/info/exclude is NOT honoured", () => {
    const gitDir = git(["rev-parse", "--absolute-git-dir"], wtDir).out;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), "/.env\n/.sentinal.env\n");

    writeFileSync(join(wtDir, ".env"), "A=B\n");
    writeFileSync(join(wtDir, ".sentinal.env"), "SENTINAL_WORKTREE_SLOT=1\n");

    // Writing to the per-worktree gitdir avoids the leak — but git never reads it.
    expect(isIgnored(wtDir, ".env")).toBe(false);
    expect(isIgnored(wtDir, ".sentinal.env")).toBe(false);
    expect(git(["status", "--porcelain"], wtDir).out).toContain(".env");
  });

  // ── 3. SELECTED: self-ignoring worktree-local .gitignore ────────────────

  it("SELECTED: a self-ignoring worktree-local .gitignore hides the files inside the worktree", () => {
    writeFileSync(
      join(wtDir, ".gitignore"),
      "/.gitignore\n/.env\n/.sentinal/\n",
    );
    writeFileSync(join(wtDir, ".env"), "A=B\n");
    mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
    writeFileSync(
      join(wtDir, ".sentinal", "worktree.env"),
      "SENTINAL_WORKTREE_SLOT=1\n",
    );

    // check-ignore -v names the source file, line and pattern for each path
    const v = git(
      [
        "check-ignore",
        "-v",
        "--",
        ".gitignore",
        ".env",
        ".sentinal/worktree.env",
      ],
      wtDir,
    );
    expect(v.code).toBe(0);
    expect(v.out).toContain(".gitignore:1:/.gitignore\t.gitignore");
    expect(v.out).toContain(".gitignore:2:/.env\t.env");
    expect(v.out).toContain(".gitignore:3:/.sentinal/\t.sentinal/worktree.env");

    // The whole point: `git status` in the worktree stays clean.
    expect(git(["status", "--porcelain"], wtDir).out).toBe("");
  });

  it("SELECTED: the main checkout is completely unaffected — exclude file byte-identical, status clean", () => {
    const excludePath = join(repoDir, ".git", "info", "exclude");
    const before = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);

    writeFileSync(
      join(wtDir, ".gitignore"),
      "/.gitignore\n/.env\n/.sentinal/\n",
    );
    writeFileSync(join(wtDir, ".env"), "A=B\n");

    const after = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);

    // Byte-for-byte unchanged — zero common-dir writes.
    expect(after.equals(before)).toBe(true);
    // And the main checkout has no new/modified files and no new ignore rules.
    expect(git(["status", "--porcelain"], repoDir).out).toBe("");
    expect(isIgnored(repoDir, ".env")).toBe(false);
  });

  // ── 4. Pre-check: does the repo's committed .gitignore already cover it? ─

  it("no write is needed when the repo's COMMITTED .gitignore already covers .env", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n.env\n");

    // Inherited from the commit — the worktree needs no mechanism at all.
    expect(isIgnored(wtDir, ".env")).toBe(true);
    expect(existsSync(join(wtDir, ".gitignore"))).toBe(true);
    expect(isTracked(wtDir, ".gitignore")).toBe(true);
  });

  it("a TRACKED root .gitignore is detectable, so we can refuse to dirty it", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n");

    expect(isTracked(wtDir, ".gitignore")).toBe(true);
    expect(isIgnored(wtDir, ".env")).toBe(false);

    // Demonstrate WHY we must refuse: appending to a tracked .gitignore hides
    // the .env but leaves a staged-able modification that `git add -A` sweeps up.
    writeFileSync(join(wtDir, ".gitignore"), "node_modules/\n/.env\n");
    writeFileSync(join(wtDir, ".env"), "A=B\n");
    expect(isIgnored(wtDir, ".env")).toBe(true);
    // (leading status column is stripped by our .trim() helper)
    expect(git(["status", "--porcelain"], wtDir).out).toBe("M .gitignore");
  });

  it("an UNTRACKED root .gitignore is detectable, so appending to it is safe", () => {
    // Fresh repo with no .gitignore at all (the default `setup()`).
    expect(isTracked(wtDir, ".gitignore")).toBe(false);
    expect(existsSync(join(wtDir, ".gitignore"))).toBe(false);
  });

  // ── 5. Directory-scoped fallback for sentinal-owned files ───────────────

  it("FALLBACK: a self-ignoring .sentinal/.gitignore hides sentinal files even when the root .gitignore is tracked", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n");

    mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
    // "*" matches .gitignore itself, so a single line is fully self-ignoring.
    writeFileSync(join(wtDir, ".sentinal", ".gitignore"), "*\n");
    writeFileSync(
      join(wtDir, ".sentinal", "worktree.env"),
      "SENTINAL_WORKTREE_SLOT=1\n",
    );

    expect(isIgnored(wtDir, ".sentinal/worktree.env")).toBe(true);
    expect(isIgnored(wtDir, ".sentinal/.gitignore")).toBe(true);
    expect(git(["status", "--porcelain"], wtDir).out).toBe("");
    // Root .gitignore untouched.
    expect(readFileSync(join(wtDir, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n",
    );
  });
});
