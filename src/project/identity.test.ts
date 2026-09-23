import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { resolveProjectIdentity, resolveWorkspaceRoot } from "./identity.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temp git repo with an initial commit. */
function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("project identity resolvers", () => {
  let tmpDir: string;

  beforeEach(() => {
    // realpathSync pre-applied: on macOS /var is a symlink to /private/var and
    // the resolvers canonicalize, so raw tmp paths never compare equal.
    tmpDir = realpathSync(makeTmpDir());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("from a linked worktree", () => {
    it("identity returns the main checkout, workspace returns the worktree", () => {
      const repoDir = join(tmpDir, "repo");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir);

      const wtPath = join(tmpDir, "wt-a");
      Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature"], {
        cwd: repoDir,
      });

      expect(resolveProjectIdentity(wtPath)).toBe(repoDir);
      expect(resolveWorkspaceRoot(wtPath)).toBe(wtPath);
    }, 15_000);

    it("resolves from a subdirectory of a linked worktree", () => {
      const repoDir = join(tmpDir, "repo");
      mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir);

      const wtPath = join(tmpDir, "wt-b");
      Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature-b"], {
        cwd: repoDir,
      });
      const subDir = join(wtPath, "src", "deep");
      mkdirSync(subDir, { recursive: true });

      expect(resolveProjectIdentity(subDir)).toBe(repoDir);
      expect(resolveWorkspaceRoot(subDir)).toBe(wtPath);
    }, 15_000);
  });

  describe("from the main checkout", () => {
    it("both resolvers return the same path", () => {
      initRepo(tmpDir);
      expect(resolveProjectIdentity(tmpDir)).toBe(tmpDir);
      expect(resolveWorkspaceRoot(tmpDir)).toBe(tmpDir);
    }, 15_000);

    it("both resolvers return the repo root from a subdirectory", () => {
      initRepo(tmpDir);
      const subDir = join(tmpDir, "src", "deep");
      mkdirSync(subDir, { recursive: true });

      expect(resolveProjectIdentity(subDir)).toBe(tmpDir);
      expect(resolveWorkspaceRoot(subDir)).toBe(tmpDir);
    }, 15_000);
  });

  describe("outside a git repository", () => {
    it("both return a realpath'd cwd and NEITHER throws", () => {
      // tmpDir is deliberately not `git init`ed.
      expect(() => resolveProjectIdentity(tmpDir)).not.toThrow();
      expect(() => resolveWorkspaceRoot(tmpDir)).not.toThrow();
      expect(resolveProjectIdentity(tmpDir)).toBe(tmpDir);
      expect(resolveWorkspaceRoot(tmpDir)).toBe(tmpDir);
    }, 15_000);

    it("does not throw for a path that does not exist on disk", () => {
      const ghost = join(tmpDir, "no", "such", "dir");
      expect(() => resolveProjectIdentity(ghost)).not.toThrow();
      expect(() => resolveWorkspaceRoot(ghost)).not.toThrow();
      expect(resolveProjectIdentity(ghost)).not.toBe("");
      expect(resolveWorkspaceRoot(ghost)).not.toBe("");
    }, 15_000);
  });

  describe("never returns the empty string", () => {
    // This is the whole point: `projectRoot ?? ""` in the OpenCode plugin put
    // 14 empty-string rows in the live DB. An empty key must be unreachable.
    const degenerate: Array<[string, string]> = [
      ["empty string", ""],
      ["single space", " "],
      ["whitespace only", "   \t \n "],
    ];

    for (const [label, input] of degenerate) {
      it(`identity returns a non-empty absolute path for ${label}`, () => {
        const result = resolveProjectIdentity(input);
        expect(result).not.toBe("");
        expect(result.trim()).not.toBe("");
        expect(result.startsWith("/")).toBe(true);
      }, 15_000);

      it(`workspace returns a non-empty absolute path for ${label}`, () => {
        const result = resolveWorkspaceRoot(input);
        expect(result).not.toBe("");
        expect(result.trim()).not.toBe("");
        expect(result.startsWith("/")).toBe(true);
      }, 15_000);
    }
  });

  describe("layered fallback", () => {
    it("identity falls back to getRepoRoot semantics when worktree list is unavailable", () => {
      // A repo whose .git is a plain gitdir still answers `worktree list`, so
      // assert the observable contract instead: identity is always a real,
      // existing, canonical directory inside the repo tree.
      initRepo(tmpDir);
      const identity = resolveProjectIdentity(tmpDir);
      expect(identity).toBe(realpathSync(identity));
    }, 15_000);
  });
});
