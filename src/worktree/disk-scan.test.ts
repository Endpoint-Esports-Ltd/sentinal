/**
 * Disk-scan helpers extracted from manager.ts (R4 — manager.ts is against the
 * 600-line block limit). Behaviour must be byte-identical to the inlined
 * versions; these tests pin it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { listGitWorktrees, resolveRealPath, isInside } from "./disk-scan.js";

describe("disk-scan", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("listGitWorktrees", () => {
    it("returns an empty list for a repo with only the main checkout", () => {
      // The main checkout has a branch line, but no linked worktrees exist.
      const entries = listGitWorktrees(repoDir);
      expect(entries.map((e) => e.path)).toEqual([repoDir]);
    });

    it("lists linked worktrees with path, head and short branch name", () => {
      const wtPath = join(tmpDir, "wt-a");
      Bun.spawnSync(
        ["git", "worktree", "add", wtPath, "-b", "sentinal/spec-x"],
        {
          cwd: repoDir,
        },
      );

      const entry = listGitWorktrees(repoDir).find((e) => e.path === wtPath);
      expect(entry).toBeDefined();
      expect(entry!.branch).toBe("sentinal/spec-x"); // refs/heads/ stripped
      expect(entry!.head).toMatch(/^[a-f0-9]{40}$/);
    });

    it("skips detached entries that have no branch line", () => {
      const wtPath = join(tmpDir, "wt-detached");
      Bun.spawnSync(["git", "worktree", "add", "--detach", wtPath], {
        cwd: repoDir,
      });
      expect(listGitWorktrees(repoDir).map((e) => e.path)).not.toContain(
        wtPath,
      );
    });

    it("returns an empty list outside a git repo instead of throwing", () => {
      const notARepo = join(tmpDir, "plain");
      mkdirSync(notARepo, { recursive: true });
      expect(listGitWorktrees(notARepo)).toEqual([]);
    });
  });

  describe("resolveRealPath", () => {
    it("canonicalises an existing path", () => {
      expect(resolveRealPath(repoDir)).toBe(realpathSync(repoDir));
    });

    it("falls back to a plain resolve for a non-existent path", () => {
      const missing = join(tmpDir, "nope");
      expect(resolveRealPath(missing)).toBe(missing);
    });
  });

  describe("isInside", () => {
    it("is true for a strict descendant", () => {
      const child = join(repoDir, ".sentinal", "worktrees", "spec-a");
      mkdirSync(child, { recursive: true });
      expect(isInside(child, repoDir)).toBe(true);
    });

    it("is false for the parent itself (strict containment)", () => {
      expect(isInside(repoDir, repoDir)).toBe(false);
    });

    it("is false for a sibling whose name merely shares a prefix", () => {
      const sibling = `${repoDir}-evil`;
      mkdirSync(sibling, { recursive: true });
      expect(isInside(sibling, repoDir)).toBe(false);
    });
  });
});
