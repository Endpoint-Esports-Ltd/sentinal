import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  gitExec,
  gitExecOrThrow,
  getCurrentBranch,
  branchExists,
  detectBaseBranch,
  getRepoRoot,
  getCurrentCommit,
  getGitVersion,
  checkGitVersion,
  slugify,
  randomHex,
} from "./utils.js";
import { WorktreeError } from "../worktree/types.js";

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

describe("git utils", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("gitExec", () => {
    it("should run a git command and return result", () => {
      initRepo(tmpDir);
      const result = gitExec(["status", "--short"], tmpDir);
      expect(result.exitCode).toBe(0);
    });

    it("should return non-zero for invalid commands", () => {
      initRepo(tmpDir);
      const result = gitExec(["invalid-command-xyz"], tmpDir);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("gitExecOrThrow", () => {
    it("should return stdout on success", () => {
      initRepo(tmpDir);
      const out = gitExecOrThrow(
        ["rev-parse", "--is-inside-work-tree"],
        tmpDir,
      );
      expect(out).toBe("true");
    });

    it("should throw WorktreeError on failure", () => {
      initRepo(tmpDir);
      expect(() =>
        gitExecOrThrow(
          ["rev-parse", "--verify", "refs/heads/nonexistent"],
          tmpDir,
        ),
      ).toThrow(WorktreeError);
    });
  });

  describe("getCurrentBranch", () => {
    it("should return main for a new repo", () => {
      initRepo(tmpDir);
      expect(getCurrentBranch(tmpDir)).toBe("main");
    });

    it("should throw for non-git directory", () => {
      expect(() => getCurrentBranch(tmpDir)).toThrow(WorktreeError);
    });
  });

  describe("branchExists", () => {
    it("should return true for existing branch", () => {
      initRepo(tmpDir);
      expect(branchExists(tmpDir, "main")).toBe(true);
    });

    it("should return false for non-existent branch", () => {
      initRepo(tmpDir);
      expect(branchExists(tmpDir, "nonexistent")).toBe(false);
    });
  });

  describe("detectBaseBranch", () => {
    it("should detect main branch", () => {
      initRepo(tmpDir);
      expect(detectBaseBranch(tmpDir)).toBe("main");
    });

    it("should detect master branch when main doesn't exist", () => {
      Bun.spawnSync(["git", "init", "-b", "master"], { cwd: tmpDir });
      Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
        cwd: tmpDir,
      });
      Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Test\n");
      Bun.spawnSync(["git", "add", "."], { cwd: tmpDir });
      Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: tmpDir });
      expect(detectBaseBranch(tmpDir)).toBe("master");
    });
  });

  describe("getRepoRoot", () => {
    it("should return the repo root from a subdirectory", () => {
      initRepo(tmpDir);
      const subDir = join(tmpDir, "src", "deep");
      mkdirSync(subDir, { recursive: true });
      expect(getRepoRoot(subDir)).toBe(tmpDir);
    });

    it("should throw for non-git directory", () => {
      expect(() => getRepoRoot(tmpDir)).toThrow(WorktreeError);
    });
  });

  describe("getCurrentCommit", () => {
    it("should return a 40-char hex string", () => {
      initRepo(tmpDir);
      const commit = getCurrentCommit(tmpDir);
      expect(commit).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe("getGitVersion", () => {
    it("should return a 3-element tuple", () => {
      const version = getGitVersion();
      expect(version).toHaveLength(3);
      expect(version[0]).toBeGreaterThanOrEqual(2);
    });
  });

  describe("checkGitVersion", () => {
    it("should report ok for modern git", () => {
      const result = checkGitVersion();
      expect(result.ok).toBe(true);
      expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("slugify", () => {
    it("should convert spaces to hyphens", () => {
      expect(slugify("add auth module")).toBe("add-auth-module");
    });

    it("should remove special characters", () => {
      expect(slugify("fix: login (crash)")).toBe("fix-login-crash");
    });

    it("should lowercase", () => {
      expect(slugify("Add Auth")).toBe("add-auth");
    });

    it("should collapse multiple hyphens", () => {
      expect(slugify("fix---this")).toBe("fix-this");
    });

    it("should trim hyphens", () => {
      expect(slugify("-leading-trailing-")).toBe("leading-trailing");
    });

    it("should truncate to maxLength", () => {
      const long = "a".repeat(100);
      expect(slugify(long, 10)).toHaveLength(10);
    });

    it("should handle underscores", () => {
      expect(slugify("snake_case_name")).toBe("snake-case-name");
    });
  });

  describe("randomHex", () => {
    it("should return hex string of correct length", () => {
      const hex = randomHex(4);
      expect(hex).toHaveLength(8);
      expect(hex).toMatch(/^[a-f0-9]+$/);
    });

    it("should generate unique values", () => {
      const a = randomHex();
      const b = randomHex();
      expect(a).not.toBe(b);
    });
  });
});
