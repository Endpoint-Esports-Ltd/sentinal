/**
 * Unit-level cover for the two `squashMerge` guards.
 *
 * The behavioural contract ("the row must never say `merged` while the
 * directory is still there") is asserted end to end in `manager.test.ts`. This
 * file pins the pieces that are easy to get subtly wrong in isolation:
 *
 * - ignored files must NOT count as dirty (Sentinal seeds its own),
 * - `--untracked-files=all` must be used, or the message names `.sentinal/`
 *   instead of `.sentinal/runtime.json`,
 * - the branch must survive a failed removal, not be half-deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  gitVisibleChanges,
  assertCleanForMerge,
  mainCheckoutTrackedChanges,
  assertMainCheckoutCleanForMerge,
  assertBaseFreeForMerge,
  resolveMergeCheckout,
  removeMergedWorktree,
} from "./merge-guards.js";
import { WorktreeError, type Worktree } from "./types.js";

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd });
}

describe("merge-guards", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtDir: string;
  let wt: Worktree;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    wtDir = join(tmpDir, "wt");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "t@t.com"], repoDir);
    git(["config", "user.name", "T"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "init"], repoDir);
    git(["worktree", "add", wtDir, "-b", "feat"], repoDir);

    wt = {
      id: "w1",
      projectPath: repoDir,
      worktreePath: wtDir,
      branchName: "feat",
      baseBranch: "main",
      baseCommit: "0".repeat(40),
      status: "active",
      slot: 1,
      createdAt: Date.now(),
    };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("gitVisibleChanges", () => {
    it("is empty for a pristine worktree", () => {
      expect(gitVisibleChanges(wtDir)).toEqual([]);
    });

    it("names the FILE inside an untracked directory, not the directory", () => {
      // ⛔ Plain `--porcelain` collapses this to `?? .sentinal/`, which would
      // point the reader at the container rather than the file to deal with.
      mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
      writeFileSync(join(wtDir, ".sentinal", "runtime.json"), "{}");
      expect(gitVisibleChanges(wtDir)).toEqual([".sentinal/runtime.json"]);
    });

    it("does NOT count ignored files — Sentinal seeds its own", () => {
      // The exact mechanism `git-exclude.ts` tier 2 uses.
      writeFileSync(join(wtDir, ".gitignore"), "/.gitignore\n.env\n");
      writeFileSync(join(wtDir, ".env"), "SECRET=1\n");
      expect(gitVisibleChanges(wtDir)).toEqual([]);
    });

    it("counts a modified tracked file", () => {
      writeFileSync(join(wtDir, "README.md"), "# changed\n");
      expect(gitVisibleChanges(wtDir)).toEqual(["README.md"]);
    });
  });

  describe("assertCleanForMerge", () => {
    it("passes on a pristine worktree", () => {
      expect(() => assertCleanForMerge(wt)).not.toThrow();
    });

    it("passes on an ignored-only worktree", () => {
      writeFileSync(join(wtDir, ".gitignore"), "/.gitignore\n.env\n");
      writeFileSync(join(wtDir, ".env"), "SECRET=1\n");
      expect(() => assertCleanForMerge(wt)).not.toThrow();
    });

    it("throws DIRTY_WORKTREE naming the path and the remedies", () => {
      mkdirSync(join(wtDir, ".sentinal"), { recursive: true });
      writeFileSync(join(wtDir, ".sentinal", "runtime.json"), "{}");
      try {
        assertCleanForMerge(wt);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("DIRTY_WORKTREE");
        expect(err instanceof Error ? err.message : "").toContain(
          ".sentinal/runtime.json",
        );
        expect(err instanceof Error ? err.message : "").toContain(
          "worktree_abandon",
        );
        // Retry-safety is the whole value of doing this BEFORE the merge.
        expect(err instanceof Error ? err.message : "").toContain(
          "Nothing has been merged",
        );
      }
    });
  });

  // ─── H3: the OTHER side of the merge — the main checkout ──────────────────
  //
  // `squashMerge` runs `git checkout` + `git commit` in wt.projectPath, so a
  // user with staged edits there would get them silently committed INTO the
  // squash commit. Untracked files are deliberately allowed: `git commit -m`
  // cannot commit them, so they are not a pollution risk.

  describe("mainCheckoutTrackedChanges", () => {
    it("is empty for a pristine main checkout", () => {
      expect(mainCheckoutTrackedChanges(repoDir)).toEqual([]);
    });

    it("does NOT count untracked files — git commit -m cannot commit them", () => {
      writeFileSync(join(repoDir, "scratch.txt"), "notes\n");
      expect(mainCheckoutTrackedChanges(repoDir)).toEqual([]);
    });

    it("counts a staged new file", () => {
      writeFileSync(join(repoDir, "staged.txt"), "user work\n");
      git(["add", "staged.txt"], repoDir);
      expect(mainCheckoutTrackedChanges(repoDir)).toEqual(["staged.txt"]);
    });

    it("counts an unstaged modification to a tracked file", () => {
      writeFileSync(join(repoDir, "README.md"), "# changed\n");
      expect(mainCheckoutTrackedChanges(repoDir)).toEqual(["README.md"]);
    });
  });

  describe("assertMainCheckoutCleanForMerge", () => {
    it("passes on a pristine main checkout", () => {
      expect(() => assertMainCheckoutCleanForMerge(wt)).not.toThrow();
    });

    it("passes when the main checkout only holds untracked files", () => {
      writeFileSync(join(repoDir, "scratch.txt"), "notes\n");
      expect(() => assertMainCheckoutCleanForMerge(wt)).not.toThrow();
    });

    it("throws DIRTY_MAIN_CHECKOUT naming the path and the remedy", () => {
      writeFileSync(join(repoDir, "staged.txt"), "user work\n");
      git(["add", "staged.txt"], repoDir);
      try {
        assertMainCheckoutCleanForMerge(wt);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("DIRTY_MAIN_CHECKOUT");
        const msg = err instanceof Error ? err.message : "";
        expect(msg).toContain("staged.txt");
        // The remedy must be actionable: commit or stash.
        expect(msg).toContain("stash");
        // Retry-safety: this fires BEFORE anything is done.
        expect(msg).toContain("Nothing has been merged");
      }
    });

    it("throws on an unstaged tracked modification too", () => {
      writeFileSync(join(repoDir, "README.md"), "# changed\n");
      try {
        assertMainCheckoutCleanForMerge(wt);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as WorktreeError).code).toBe("DIRTY_MAIN_CHECKOUT");
        expect(err instanceof Error ? err.message : "").toContain("README.md");
      }
    });
  });

  // ─── D3: merge in the checkout that holds the base ────────────────────────

  describe("resolveMergeCheckout", () => {
    it("is the main checkout when it holds the base (today's behaviour)", () => {
      expect(resolveMergeCheckout(wt)).toBe(repoDir);
    });

    it("is the main checkout when the base is checked out nowhere", () => {
      git(["branch", "develop"], repoDir);
      expect(resolveMergeCheckout({ ...wt, baseBranch: "develop" })).toBe(
        repoDir,
      );
    });

    it("is the linked worktree that holds the base", () => {
      const holder = join(tmpDir, "holder");
      git(["worktree", "add", "-b", "coord", holder], repoDir);
      expect(resolveMergeCheckout({ ...wt, baseBranch: "coord" })).toBe(holder);
    });

    it("never picks the worktree being merged itself", () => {
      // The child's own checkout holds its base (someone switched it): a merge
      // "into itself" is nonsense, so fall back and let the guard refuse.
      const child = { ...wt, baseBranch: "feat", branchName: "other" };
      expect(resolveMergeCheckout(child)).toBe(repoDir);
      expect(() => assertBaseFreeForMerge(child, repoDir)).toThrow(
        /BASE_CHECKED_OUT|checked out/,
      );
    });

    it("never picks a holder whose directory is gone", () => {
      const holder = join(tmpDir, "gone");
      git(["worktree", "add", "-b", "coord", holder], repoDir);
      rmSync(holder, { recursive: true, force: true });
      expect(resolveMergeCheckout({ ...wt, baseBranch: "coord" })).toBe(
        repoDir,
      );
    });
  });

  describe("assertBaseFreeForMerge with a chosen checkout", () => {
    it("does not fire when the chosen checkout IS the holder", () => {
      const holder = join(tmpDir, "holder");
      git(["worktree", "add", "-b", "coord", holder], repoDir);
      const child = { ...wt, baseBranch: "coord" };
      expect(() => assertBaseFreeForMerge(child, holder)).not.toThrow();
    });

    it("fires BASE_CHECKED_OUT when the base is held somewhere else", () => {
      const holder = join(tmpDir, "holder");
      git(["worktree", "add", "-b", "coord", holder], repoDir);
      try {
        assertBaseFreeForMerge({ ...wt, baseBranch: "coord" }, repoDir);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as WorktreeError).code).toBe("BASE_CHECKED_OUT");
        expect((err as Error).message).toContain(holder);
      }
    });
  });

  describe("assertMainCheckoutCleanForMerge on a chosen checkout", () => {
    it("checks the chosen checkout, names it, and gives the coordinator remedy", () => {
      const holder = join(tmpDir, "holder");
      git(["worktree", "add", "-b", "coord", holder], repoDir);
      writeFileSync(join(holder, "README.md"), "# edited\n");
      // The main checkout is clean — only the holder is dirty.
      expect(() => assertMainCheckoutCleanForMerge(wt)).not.toThrow();
      try {
        assertMainCheckoutCleanForMerge({ ...wt, baseBranch: "coord" }, holder);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as WorktreeError).code).toBe("DIRTY_MAIN_CHECKOUT");
        const msg = (err as Error).message;
        expect(msg).toContain(holder);
        expect(msg).toContain("README.md");
        expect(msg).toContain("commit or stash them");
        expect(msg).toContain("coordinator should commit its plan edits");
      }
    });
  });

  describe("removeMergedWorktree", () => {
    it("removes the directory and deletes the branch", () => {
      removeMergedWorktree(wt, "a".repeat(40));
      expect(gitVisibleChanges(repoDir)).toEqual([]);
      const branches = Bun.spawnSync(["git", "branch", "--list", "feat"], {
        cwd: repoDir,
        stdout: "pipe",
      });
      expect((branches.stdout?.toString() ?? "").trim()).toBe("");
    });

    it("throws REMOVE_FAILED and KEEPS the branch when the directory survives", () => {
      writeFileSync(join(wtDir, "untracked.txt"), "x");
      try {
        removeMergedWorktree(wt, "b".repeat(40));
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("REMOVE_FAILED");
        // The merge already landed — say so, and say do not retry.
        expect(err instanceof Error ? err.message : "").toContain("LANDED");
        expect(err instanceof Error ? err.message : "").toContain(
          "Do NOT re-run the merge",
        );
      }
      // ⛔ Deleting the branch of a worktree that still exists would leave the
      // directory unrecoverable-by-name. git refuses anyway; assert we never
      // even reach for it.
      const branches = Bun.spawnSync(["git", "branch", "--list", "feat"], {
        cwd: repoDir,
        stdout: "pipe",
      });
      expect((branches.stdout?.toString() ?? "").trim()).toContain("feat");
    });
  });
});
