/**
 * Hiding Sentinal-written files from git inside a linked worktree.
 *
 * Implements the mechanism selected by the Task 1 spike
 * (`src/worktree/worktree-exclude.test.ts`): a self-ignoring worktree-local
 * `.gitignore`, gated on `git check-ignore` and on the ignore file being
 * untracked. The spike proves the git behaviour; this proves our use of it.
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
import { excludeFromGit, isIgnored, isTracked } from "./git-exclude.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("git-exclude", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtDir: string;

  function setup(rootGitignore?: string): void {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    wtDir = join(tmpDir, "wt");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "t@t.com"], repoDir);
    git(["config", "user.name", "T"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    if (rootGitignore !== undefined) {
      writeFileSync(join(repoDir, ".gitignore"), rootGitignore);
    }
    git(["add", "."], repoDir);
    git(["commit", "-m", "init"], repoDir);
    git(["worktree", "add", wtDir, "-b", "feat"], repoDir);
  }

  beforeEach(() => setup());
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Primitives ───────────────────────────────────────────────────────────

  describe("isIgnored / isTracked", () => {
    it("reports an inherited ignore rule from the committed .gitignore", () => {
      rmSync(tmpDir, { recursive: true, force: true });
      setup("node_modules/\n.env\n");
      expect(isIgnored(wtDir, ".env")).toBe(true);
      expect(isTracked(wtDir, ".gitignore")).toBe(true);
    });

    it("reports an absent file as neither ignored nor tracked", () => {
      expect(isIgnored(wtDir, ".env")).toBe(false);
      expect(isTracked(wtDir, ".gitignore")).toBe(false);
    });
  });

  // ── Tier 1: nothing to do ────────────────────────────────────────────────

  it("tier 1 — writes NOTHING when the committed .gitignore already covers the path", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n.env\n");
    const before = readFileSync(join(wtDir, ".gitignore"), "utf-8");

    const r = excludeFromGit(wtDir, [".env"]);

    expect(r.excluded).toEqual([".env"]);
    expect(r.unexcluded).toEqual([]);
    expect(r.mechanism).toBe("inherited");
    expect(readFileSync(join(wtDir, ".gitignore"), "utf-8")).toBe(before);
  });

  // ── Tier 2: create / append to an untracked .gitignore ───────────────────

  it("tier 2 — creates a SELF-IGNORING .gitignore when none is tracked", () => {
    writeFileSync(join(wtDir, ".env"), "A=B\n");

    const r = excludeFromGit(wtDir, [".env"]);

    expect(r.unexcluded).toEqual([]);
    expect(r.mechanism).toBe("worktree-gitignore");
    // The ignore file must list itself, or it becomes an untracked file of its own.
    expect(isIgnored(wtDir, ".gitignore")).toBe(true);
    expect(isIgnored(wtDir, ".env")).toBe(true);
    expect(git(["status", "--porcelain"], wtDir)).toBe("");
  });

  it("tier 2 — appends to an existing UNTRACKED .gitignore without dropping its content", () => {
    writeFileSync(join(wtDir, ".gitignore"), "/.gitignore\nscratch/\n");
    writeFileSync(join(wtDir, ".env"), "A=B\n");

    excludeFromGit(wtDir, [".env"]);

    const content = readFileSync(join(wtDir, ".gitignore"), "utf-8");
    expect(content).toContain("scratch/");
    expect(content).toContain("/.env");
    expect(git(["status", "--porcelain"], wtDir)).toBe("");
  });

  it("tier 2 — is idempotent: a second call adds no duplicate entry", () => {
    excludeFromGit(wtDir, [".env"]);
    const first = readFileSync(join(wtDir, ".gitignore"), "utf-8");
    excludeFromGit(wtDir, [".env"]);
    expect(readFileSync(join(wtDir, ".gitignore"), "utf-8")).toBe(first);
  });

  it("uses a DIRECTORY-SCOPED .gitignore for nested paths", () => {
    mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
    writeFileSync(join(wtDir, ".sentinal", "worktree.env"), "X=1\n");

    const r = excludeFromGit(wtDir, [".sentinal/worktree.env"]);

    expect(r.unexcluded).toEqual([]);
    expect(existsSync(join(wtDir, ".sentinal", ".gitignore"))).toBe(true);
    // Root .gitignore untouched — the nested one is self-contained.
    expect(existsSync(join(wtDir, ".gitignore"))).toBe(false);
    expect(isIgnored(wtDir, ".sentinal/worktree.env")).toBe(true);
    expect(git(["status", "--porcelain"], wtDir)).toBe("");
  });

  // ── Tier 3: refuse to dirty a TRACKED ignore file ────────────────────────

  it("tier 3 — REFUSES to modify a tracked .gitignore and reports the path as unexcluded", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    setup("node_modules/\n");
    writeFileSync(join(wtDir, ".env"), "A=B\n");

    const r = excludeFromGit(wtDir, [".env"]);

    expect(r.excluded).toEqual([]);
    expect(r.unexcluded).toEqual([".env"]);
    expect(r.mechanism).toBe("none");
    // The tracked file is byte-identical — `git add -A` must not sweep it up.
    expect(readFileSync(join(wtDir, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n",
    );
    // The honest consequence: the file IS visible. We report it rather than
    // hide it by dirtying a tracked file.
    expect(git(["status", "--porcelain"], wtDir)).toContain("?? .env");
    // ...and the caller gets an actionable remedy, not just a failure.
    expect(r.warnings.join("\n")).toContain(".gitignore");
    expect(r.warnings.join("\n")).toContain(".env");
  });

  // ── The main checkout is never touched ───────────────────────────────────

  it("never writes into the common dir — the main checkout is byte-unchanged", () => {
    const excludePath = join(repoDir, ".git", "info", "exclude");
    const before = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);

    writeFileSync(join(wtDir, ".env"), "A=B\n");
    mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
    writeFileSync(join(wtDir, ".sentinal", "worktree.env"), "X=1\n");
    excludeFromGit(wtDir, [".env", ".sentinal/worktree.env"]);

    const after = existsSync(excludePath)
      ? readFileSync(excludePath)
      : Buffer.alloc(0);
    expect(after.equals(before)).toBe(true);
    expect(git(["status", "--porcelain"], repoDir)).toBe("");
    expect(isIgnored(repoDir, ".env")).toBe(false);
  });

  // ── Degradation ──────────────────────────────────────────────────────────

  it("degrades to 'unexcluded' outside a git repo instead of throwing", () => {
    const plain = join(tmpDir, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, ".env"), "A=B\n");

    const r = excludeFromGit(plain, [".env"]);
    expect(r.unexcluded).toEqual([".env"]);
  });
});
