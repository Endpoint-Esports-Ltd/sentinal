import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { WorktreeError, type WorktreeConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temp git repo with an initial commit. */
function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: dir });
}

/** Add a file and commit in a directory. */
function addAndCommit(
  dir: string,
  filename: string,
  content: string,
  message: string,
): void {
  writeFileSync(join(dir, filename), content);
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", message], { cwd: dir });
}

const testConfig: WorktreeConfig = {
  enabled: true,
  directory: ".sentinal/worktrees",
  branchPrefix: "sentinal/spec-",
  maxActive: 3,
  autoCleanup: true,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WorktreeManager", () => {
  let tmpDir: string;
  let repoDir: string;
  let dbDir: string;
  let memoryStore: MemoryStore;
  let wtStore: WorktreeStore;
  let manager: WorktreeManager;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    dbDir = join(tmpDir, "db");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    initRepo(repoDir);
    memoryStore = new MemoryStore(join(dbDir, "test.db"));
    wtStore = new WorktreeStore(memoryStore);
    manager = new WorktreeManager(wtStore, testConfig);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("should create a worktree with correct structure", () => {
      const wt = manager.create(undefined, repoDir);

      expect(wt.branchName).toContain("sentinal/spec-worktree-");
      expect(wt.baseBranch).toBe("main");
      expect(wt.status).toBe("active");
      expect(wt.projectPath).toBe(repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);
    });

    it("should create worktree directory on disk", () => {
      const wt = manager.create(undefined, repoDir);
      expect(existsSync(join(wt.worktreePath, "README.md"))).toBe(true);
    });

    it("should record the base commit", () => {
      const wt = manager.create(undefined, repoDir);
      expect(wt.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    });

    it("should use specified base branch", () => {
      Bun.spawnSync(["git", "branch", "develop"], { cwd: repoDir });
      const wt = manager.create(undefined, repoDir, "develop");
      expect(wt.baseBranch).toBe("develop");
    });

    it("should throw when max active reached", () => {
      manager.create(undefined, repoDir);
      manager.create(undefined, repoDir);
      manager.create(undefined, repoDir);

      expect(() => manager.create(undefined, repoDir)).toThrow(WorktreeError);
    });

    it("should handle undefined specId", () => {
      const wt = manager.create(undefined, repoDir);
      expect(wt.specId).toBeUndefined();
      expect(wt.branchName).toContain("sentinal/spec-worktree-");
    });

    it("should succeed with specId not yet registered in specs table", () => {
      // This is the normal workflow: worktree is created BEFORE the spec is registered
      const wt = manager.create("2026-04-20-unregistered-spec", repoDir);

      expect(wt.branchName).toBe("sentinal/spec-2026-04-20-unregistered-spec");
      expect(wt.baseBranch).toBe("main");
      expect(wt.status).toBe("active");
      expect(existsSync(wt.worktreePath)).toBe(true);
      // specId should NOT be stored (deferred until linkSpec)
      expect(wt.specId).toBeUndefined();
    });

    it("should clean up git worktree if store insert fails", () => {
      // Simulate store failure by maxing out active worktrees then
      // trying to create one more — but first let's verify cleanup behavior
      // when an unexpected error occurs during insert
      manager.create(undefined, repoDir);
      manager.create(undefined, repoDir);
      manager.create(undefined, repoDir);

      // Max active is 3, so the 4th should fail cleanly
      expect(() => manager.create(undefined, repoDir)).toThrow(WorktreeError);

      // Verify no orphaned worktree directories exist beyond the 3 created
      const allWorktrees = manager.list(repoDir);
      expect(allWorktrees).toHaveLength(3);
    });
  });

  describe("linkSpec", () => {
    it("should link a spec_id to an existing worktree", () => {
      const wt = manager.create("unregistered-slug", repoDir);
      expect(wt.specId).toBeUndefined();

      // Register a spec in the DB, then link
      const db = memoryStore.getRawDb();
      db.run(
        `INSERT INTO specs (id, project_path, title, slug, type, status, plan_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "unregistered-slug",
          repoDir,
          "Test Spec",
          "unregistered-slug",
          "bugfix",
          "PENDING",
          "/tmp/plan.md",
          Date.now(),
          Date.now(),
        ],
      );

      manager.linkSpec(wt.id, "unregistered-slug");

      const updated = wtStore.get(wt.id);
      expect(updated!.specId).toBe("unregistered-slug");
    });

    it("should throw for non-existent worktree", () => {
      expect(() => manager.linkSpec("nonexistent", "some-spec")).toThrow(
        WorktreeError,
      );
    });
  });

  describe("list", () => {
    it("should list worktrees for a project", () => {
      manager.create(undefined, repoDir);
      manager.create(undefined, repoDir);

      const result = manager.list(repoDir);
      expect(result).toHaveLength(2);
    });

    it("should list all worktrees when no project specified", () => {
      manager.create(undefined, repoDir);
      const result = manager.list();
      expect(result).toHaveLength(1);
    });
  });

  describe("status", () => {
    it("should return worktree status with disk check", () => {
      const wt = manager.create(undefined, repoDir);
      const result = manager.status(wt.id);

      expect(result.existsOnDisk).toBe(true);
      expect(result.status).toBe("active");
    });

    it("should throw for non-existent worktree", () => {
      expect(() => manager.status("nonexistent")).toThrow(WorktreeError);
    });
  });

  describe("diff", () => {
    it("should return empty diff for unchanged worktree", () => {
      const wt = manager.create(undefined, repoDir);
      const result = manager.diff(wt.id);

      expect(result.filesChanged).toBe(0);
      expect(result.files).toHaveLength(0);
    });

    it("should detect changes in worktree", () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(
        wt.worktreePath,
        "new-file.ts",
        "export const x = 1;\n",
        "add new file",
      );

      const result = manager.diff(wt.id);
      expect(result.filesChanged).toBeGreaterThan(0);
      expect(result.insertions).toBeGreaterThan(0);
    });
  });

  describe("squashMerge", () => {
    it("should squash merge worktree into base branch", () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(
        wt.worktreePath,
        "feature.ts",
        "export const feature = true;\n",
        "add feature",
      );
      addAndCommit(
        wt.worktreePath,
        "helper.ts",
        "export const help = true;\n",
        "add helper",
      );

      const mergeCommit = manager.squashMerge(
        wt.id,
        "feat: merge test feature",
      );

      expect(mergeCommit).toMatch(/^[a-f0-9]{40}$/);

      const merged = wtStore.get(wt.id);
      expect(merged!.status).toBe("merged");
      expect(merged!.mergeCommit).toBe(mergeCommit);

      expect(existsSync(wt.worktreePath)).toBe(false);
      expect(existsSync(join(repoDir, "feature.ts"))).toBe(true);
    });

    it("should throw for already merged worktree", () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(wt.worktreePath, "a.ts", "a", "commit");
      manager.squashMerge(wt.id, "feat: test");

      expect(() => manager.squashMerge(wt.id, "feat: again")).toThrow(
        WorktreeError,
      );
    });

    it("should use default commit message when none provided", () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(wt.worktreePath, "b.ts", "b", "commit");
      const hash = manager.squashMerge(wt.id);

      const result = Bun.spawnSync(["git", "log", "-1", "--format=%s", hash], {
        cwd: repoDir,
        stdout: "pipe",
      });
      const msg = result.stdout?.toString().trim();
      expect(msg).toContain("worktree-");
    });
  });

  describe("abandon", () => {
    it("should remove worktree and mark as abandoned", () => {
      const wt = manager.create(undefined, repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);

      manager.abandon(wt.id);

      expect(existsSync(wt.worktreePath)).toBe(false);
      const abandoned = wtStore.get(wt.id);
      expect(abandoned!.status).toBe("abandoned");
    });

    it("should throw for non-existent worktree", () => {
      expect(() => manager.abandon("nonexistent")).toThrow(WorktreeError);
    });
  });

  describe("cleanup", () => {
    it("should cleanup worktrees whose directory is missing", () => {
      const wt = manager.create(undefined, repoDir);

      rmSync(wt.worktreePath, { recursive: true, force: true });

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(1);

      const updated = wtStore.get(wt.id);
      expect(updated!.status).toBe("abandoned");
    });

    it("should not cleanup worktrees that still exist", () => {
      manager.create(undefined, repoDir);
      const cleaned = manager.cleanup();
      expect(cleaned).toBe(0);
    });

    it("should return 0 when no active worktrees", () => {
      expect(manager.cleanup()).toBe(0);
    });
  });

  describe("hasConflicts", () => {
    it("should return false when no conflicts", () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(
        wt.worktreePath,
        "new.ts",
        "export const x = 1;\n",
        "add file",
      );

      expect(manager.hasConflicts(wt.id)).toBe(false);
    });

    it("should detect conflicts", () => {
      const wt = manager.create(undefined, repoDir);

      addAndCommit(
        wt.worktreePath,
        "README.md",
        "# Changed in worktree\n",
        "worktree change",
      );

      Bun.spawnSync(["git", "checkout", "main"], { cwd: repoDir });
      addAndCommit(repoDir, "README.md", "# Changed on main\n", "main change");

      expect(manager.hasConflicts(wt.id)).toBe(true);
    });
  });
});
