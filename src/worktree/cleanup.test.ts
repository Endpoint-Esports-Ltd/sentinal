/**
 * Cleanup + orphan-force pass.
 *
 * Extracted verbatim from `manager.test.ts` (`cleanup` :314, `cleanup(force)`
 * :343) when `cleanup.ts` was split out of `manager.ts`. The assertions are
 * unchanged on purpose: the extraction claims byte-identical behaviour, and a
 * rewritten test cannot substantiate that claim.
 */

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
import { cleanupWorktrees, type CleanupOptions } from "./cleanup.js";
import {
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  type WorktreeConfig,
} from "./types.js";

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: dir });
}

const testConfig: WorktreeConfig = {
  enabled: true,
  directory: ".sentinal/worktrees",
  branchPrefix: "sentinal/spec-",
  maxActive: 3,
  autoCleanup: true,
  // Both deps fail CLOSED when absent, so the opt-out is DECLARED, not omitted.
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
};

describe("worktree cleanup", () => {
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

  /** List worktree paths git currently tracks in repoDir. */
  function gitWorktreePaths(): string[] {
    const r = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repoDir,
    });
    return String(r.stdout)
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  }

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

  // ── cleanup(force) — orphaned worktrees whose directory STILL EXISTS ───────
  describe("cleanup(force) — orphaned present-dir worktrees", () => {
    it("default (no force) does NOT remove an orphan whose directory still exists", () => {
      const wt = manager.create("2026-07-24-orphan-a", repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("force removes a DB-active orphan whose directory still exists (class 1)", () => {
      const wt = manager.create("2026-07-24-orphan-b", repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        // Guard 5 fails CLOSED when un-injected, so every force test that
        // asserts a REMOVAL must state the liveness verdict it is testing under.
        ownsLiveRuntime: () => ({ live: false }),
      });

      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(existsSync(wt.worktreePath)).toBe(false);
      expect(gitWorktreePaths()).not.toContain(wt.worktreePath);
      expect(wtStore.get(wt.id)!.status).toBe("abandoned");
    });

    it("force removes a git-only orphan with no DB record (class 2)", () => {
      const wt = manager.create("2026-07-24-orphan-c", repoDir);
      const path = wt.worktreePath;
      wtStore.delete(wt.id);
      expect(existsSync(path)).toBe(true);

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        ownsLiveRuntime: () => ({ live: false }),
      });

      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(existsSync(path)).toBe(false);
      expect(gitWorktreePaths()).not.toContain(path);
    });

    it("force does NOT remove a worktree whose plan is IN_PROGRESS", () => {
      const wt = manager.create("2026-07-24-inprogress", repoDir);
      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: (slug) => slug.includes("2026-07-24-inprogress"),
      });
      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("force does NOT remove the caller's current worktree", () => {
      const wt = manager.create("2026-07-24-current", repoDir);
      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        currentWorktree: wt.worktreePath,
        isPlanActive: () => false,
      });
      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
    });

    // ── M3a: guard 3 must protect from a SUBDIRECTORY too ───────────────────
    //
    // A caller whose cwd is `<worktree>/src` is standing inside the worktree
    // just as surely as one at its root. Exact path equality leaves them
    // unprotected: `--force` deletes the directory the caller is standing in.
    it("M3a: force does NOT remove a worktree when current_worktree is a SUBDIRECTORY of it", () => {
      const wt = manager.create("2026-09-02-subdir", repoDir);
      const sub = join(wt.worktreePath, "src");
      mkdirSync(sub, { recursive: true });

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        currentWorktree: sub,
        isPlanActive: () => false,
        ownsLiveRuntime: () => ({ live: false }),
      });

      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("force does NOT touch a non-sentinal worktree", () => {
      const other = join(tmpDir, "feature-wt");
      Bun.spawnSync(["git", "worktree", "add", "-b", "feature/x", other], {
        cwd: repoDir,
      });
      expect(existsSync(other)).toBe(true);

      manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        ownsLiveRuntime: () => ({ live: false }),
      });

      expect(existsSync(other)).toBe(true);
      expect(gitWorktreePaths()).toContain(other);
    });

    // ── Guard 5 (Task 5) ────────────────────────────────────────────────────
    //
    // ⛔ Deleting a directory out from under a process whose cwd it is IS the
    // orphan this tier exists to prevent. Guard 5's input is deliberately
    // conservative in the opposite direction to the signalling gate: anything
    // that cannot be ruled out counts as live, because a wrong "nothing is
    // running" costs an orphan while a wrong "something is running" costs one
    // skipped cleanup and a warning.

    it("force does NOT remove a worktree that still owns live processes", () => {
      const wt = manager.create("2026-08-09-guard5", repoDir);
      const warnings: string[] = [];

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        ownsLiveRuntime: () => ({
          live: true,
          detail:
            "pid 4242 (process group 4242) is running from this worktree.",
        }),
        warnings,
      });

      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
      // Silently skipping is not acceptable: the caller asked for a cleanup and
      // must be told why it did not happen, and what to do about it.
      expect(warnings.join("\n")).toContain("4242");
      expect(warnings.join("\n")).toContain(wt.worktreePath);
    });

    it("guard 5 is consulted with each candidate's OWN path", () => {
      const a = manager.create("2026-08-09-guard5-a", repoDir);
      const b = manager.create("2026-08-09-guard5-b", repoDir);
      const asked: string[] = [];

      manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        ownsLiveRuntime: (p) => {
          asked.push(p);
          return { live: p === a.worktreePath };
        },
      });

      expect(asked).toContain(a.worktreePath);
      expect(asked).toContain(b.worktreePath);
      expect(existsSync(a.worktreePath)).toBe(true);
      expect(existsSync(b.worktreePath)).toBe(false);
    });

    it("guard 5 runs AFTER guard 4 — an IN_PROGRESS plan is never even probed", () => {
      // Ordering matters for cost, not just correctness: `ownsLiveRuntime`
      // shells out to `ps`/`lsof`, and a worktree already excluded by a cheaper
      // guard should not pay for it.
      manager.create("2026-08-09-guard5-order", repoDir);
      const asked: string[] = [];

      manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => true,
        ownsLiveRuntime: (p) => {
          asked.push(p);
          return { live: false };
        },
      });

      expect(asked).toEqual([]);
    });

    it("falls back to the INJECTED config resolver when no option is passed", () => {
      // The sidecar and the MCP tool both get the resolver from the manager's
      // config (Task 6's DI), not from the wire — guard 5's input is derived
      // server-side from the worktree's own pidfile.
      const wt = manager.create("2026-08-09-guard5-cfg", repoDir);
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        ownsLiveRuntime: () => ({ live: true, detail: "still running" }),
      });

      const cleaned = m.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
      });

      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
    });

    /**
     * ⛔ Guard 5 must fail CLOSED.
     *
     * The permissive default was the same defect class as the guard-3 gap this
     * phase just fixed: a construction site that forgets the resolver silently
     * disables the guard, and `--force` then deletes directories with no
     * running-process check at all. The backward-compatibility argument is
     * weaker than it looks — the default only applies to `force: true`, which
     * is already opt-in and DESTRUCTIVE.
     */
    it("⛔ with NO resolver anywhere, force REFUSES to delete rather than deleting blind", () => {
      const wt = manager.create("2026-08-09-guard5-inert", repoDir);
      const warnings: string[] = [];

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
        warnings,
      });

      expect(cleaned).toBe(0);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
      // Silence would read as "there was nothing to do" — the exact misreading
      // that sends an agent to `rm -rf`.
      expect(warnings.join("\n").toLowerCase()).toContain("refus");
      expect(warnings.join("\n")).toContain("liveness");
    });

    it("the un-injected refusal does NOT disable the default directory-gone pass", () => {
      // Guard 5 governs the opt-in `force` pass only. A worktree whose
      // directory is already gone owns no live process by construction.
      const gone = manager.create("2026-08-09-guard5-inert-gone", repoDir);
      rmSync(gone.worktreePath, { recursive: true, force: true });

      const cleaned = manager.cleanup({
        force: true,
        projectPath: repoDir,
        isPlanActive: () => false,
      });

      expect(cleaned).toBe(1);
      expect(wtStore.get(gone.id)!.status).toBe("abandoned");
    });
  });

  // ── M3b: the default pass must be scopable to one project ─────────────────
  //
  // `store.listAll("active")` spans EVERY project Sentinal has ever tracked,
  // and the default pass runs `git branch -D` in each row's own repo. A
  // cleanup requested for project A must not delete branches in project B.
  describe("default-pass project scoping", () => {
    let repoB: string;

    beforeEach(() => {
      repoB = join(tmpDir, "repoB");
      mkdirSync(repoB, { recursive: true });
      initRepo(repoB);
    });

    it("M3b: cleanup scoped to project A does NOT touch project B's rows or branches", () => {
      const wtA = manager.create("2026-09-02-scope-a", repoDir);
      const wtB = manager.create("2026-09-02-scope-b", repoB);
      // Both directories gone → both are default-pass candidates.
      rmSync(wtA.worktreePath, { recursive: true, force: true });
      rmSync(wtB.worktreePath, { recursive: true, force: true });

      const cleaned = manager.cleanup({ projectPath: repoDir });

      expect(cleaned).toBe(1);
      expect(wtStore.get(wtA.id)!.status).toBe("abandoned");
      // Project B untouched: row still active, branch still present.
      expect(wtStore.get(wtB.id)!.status).toBe("active");
      const branches = Bun.spawnSync(
        ["git", "branch", "--list", wtB.branchName],
        { cwd: repoB },
      );
      expect(String(branches.stdout)).toContain(
        wtB.branchName.replace(/^refs\/heads\//, ""),
      );
    });

    it("an UNSCOPED cleanup keeps the historical global behaviour", () => {
      const wtA = manager.create("2026-09-02-global-a", repoDir);
      const wtB = manager.create("2026-09-02-global-b", repoB);
      rmSync(wtA.worktreePath, { recursive: true, force: true });
      rmSync(wtB.worktreePath, { recursive: true, force: true });

      const cleaned = manager.cleanup();

      expect(cleaned).toBe(2);
      expect(wtStore.get(wtA.id)!.status).toBe("abandoned");
      expect(wtStore.get(wtB.id)!.status).toBe("abandoned");
    });
  });

  // ── The extracted free function, called directly ──────────────────────────
  describe("cleanupWorktrees (direct)", () => {
    it("is what the manager delegates to — same result via either entry point", () => {
      const wt = manager.create("2026-08-08-direct", repoDir);
      rmSync(wt.worktreePath, { recursive: true, force: true });

      expect(cleanupWorktrees(wtStore, testConfig)).toBe(1);
      expect(wtStore.get(wt.id)!.status).toBe("abandoned");
    });

    it("accepts CleanupOptions re-exported from manager.ts", () => {
      // `CleanupOptions` has no external consumers today, but it is part of the
      // manager's published surface — re-exported for hygiene after the split.
      const opts: CleanupOptions = { force: false };
      expect(cleanupWorktrees(wtStore, testConfig, opts)).toBe(0);
    });
  });
});
