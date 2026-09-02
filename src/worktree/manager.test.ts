import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import {
  MAIN_CHECKOUT_SLOT,
  SLOT_ENV_RELATIVE_PATH,
  readSlotFromWorktree,
} from "./slots.js";
import { SLOT_PLACEHOLDER } from "./worktree-config.js";
import {
  WorktreeError,
  DEFAULT_WORKTREE_CONFIG,
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  type WorktreeConfig,
} from "./types.js";

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
  // Declared, not forgotten — see "DEFAULT_WORKTREE_CONFIG opts out EXPLICITLY".
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
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
    it("should squash merge worktree into base branch", async () => {
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

      const mergeCommit = await manager.squashMerge(
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

    it("should throw for already merged worktree", async () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(wt.worktreePath, "a.ts", "a", "commit");
      await manager.squashMerge(wt.id, "feat: test");

      await expect(manager.squashMerge(wt.id, "feat: again")).rejects.toThrow(
        WorktreeError,
      );
    });

    it("should use default commit message when none provided", async () => {
      const wt = manager.create(undefined, repoDir);
      addAndCommit(wt.worktreePath, "b.ts", "b", "commit");
      const hash = await manager.squashMerge(wt.id);

      const result = Bun.spawnSync(["git", "log", "-1", "--format=%s", hash], {
        cwd: repoDir,
        stdout: "pipe",
      });
      const msg = result.stdout?.toString().trim();
      expect(msg).toContain("worktree-");
    });
  });

  // ─── squashMerge never releases a slot it did not free ────────────────────
  //
  // ⛔ `git worktree remove` WITHOUT `--force` refuses on a worktree carrying
  // modified-or-untracked files (verified: exit 128, "contains modified or
  // untracked files"). The removal is a bare `gitExec`, so the refusal is
  // swallowed — and the row was still marked `merged`, which is TERMINAL and
  // therefore frees the row's slot (`LIVE_WORKTREE_STATUSES`). The next
  // worktree gets that slot while the old directory, its seeded `.env` and its
  // ports are still on disk: the exact collision this phase exists to prevent.
  //
  // R9 made this materially reachable — `.sentinal/runtime.json` is
  // deliberately COMMITTABLE, so it is not covered by the worktree-local
  // `.gitignore` Sentinal writes, and a `/sync`-scaffolded-but-uncommitted
  // contract is precisely such an untracked file.

  describe("squashMerge with a directory git will not remove", () => {
    /** Stage an untracked file git can actually SEE, and prove that it can. */
    function scaffoldUncommittedContract(wt: { worktreePath: string }): void {
      mkdirSync(join(wt.worktreePath, ".sentinal"), { recursive: true });
      writeFileSync(
        join(wt.worktreePath, ".sentinal", "runtime.json"),
        JSON.stringify({ up: "npm start" }),
      );
      // ⛔ Load-bearing: Sentinal hides its OWN seeded files behind a
      // worktree-local `.gitignore`, and a test staging a file that turned out
      // to be ignored would assert nothing at all (git removes an
      // ignored-only worktree happily — verified).
      const status = Bun.spawnSync(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        { cwd: wt.worktreePath, stdout: "pipe" },
      );
      expect(status.stdout?.toString() ?? "").toContain(
        ".sentinal/runtime.json",
      );
    }

    it("refuses the merge outright rather than marking a surviving directory merged", async () => {
      const wt = manager.create("2026-08-20-dirty-merge", repoDir);
      addAndCommit(wt.worktreePath, "z.ts", "z", "commit");
      scaffoldUncommittedContract(wt);

      await expect(manager.squashMerge(wt.id)).rejects.toThrow(WorktreeError);

      const after = wtStore.get(wt.id)!;
      // The whole point: the slot is NOT released while the directory lives.
      expect(after.status).not.toBe("merged");
      expect(after.slot).toBe(wt.slot!);
      expect(existsSync(wt.worktreePath)).toBe(true);
      // Refused BEFORE anything was done — no half-finished merge on base.
      expect(existsSync(join(repoDir, "z.ts"))).toBe(false);
    });

    it("names the offending path and the remedy", async () => {
      const wt = manager.create("2026-08-20-dirty-merge-msg", repoDir);
      addAndCommit(wt.worktreePath, "z.ts", "z", "commit");
      scaffoldUncommittedContract(wt);

      await expect(manager.squashMerge(wt.id)).rejects.toThrow(
        /\.sentinal\/runtime\.json/,
      );
      await expect(manager.squashMerge(wt.id)).rejects.toThrow(
        /worktree_abandon/,
      );
    });

    it("still refuses to mark merged when the directory only becomes unremovable mid-merge", async () => {
      // The preflight cannot see a file that does not exist yet. The stop hook
      // is the one caller-controlled point between the preflight and the
      // removal, which makes it the only honest way to stage that race.
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: async (worktreePath: string) => {
          writeFileSync(join(worktreePath, "appeared-late.txt"), "x");
          return { ok: true, stopped: false, actions: [], warnings: [] };
        },
      });
      const wt = m.create("2026-08-20-late-dirty", repoDir);
      addAndCommit(wt.worktreePath, "q.ts", "q", "commit");

      await expect(m.squashMerge(wt.id)).rejects.toThrow(WorktreeError);

      const after = wtStore.get(wt.id)!;
      expect(after.status).not.toBe("merged");
      expect(existsSync(wt.worktreePath)).toBe(true);
      // Here the merge DID land, so the error has to say so.
      expect(existsSync(join(repoDir, "q.ts"))).toBe(true);
    });
  });

  // ─── H3: squashMerge must not swallow the MAIN checkout's work ────────────
  //
  // ⛔ `squashMerge` runs `git checkout base` + `git commit` in wt.projectPath.
  // Before the fix, a user with staged edits in the main checkout got them
  // silently committed INTO the spec's squash commit — and was left on the base
  // branch instead of the branch they were on.

  describe("squashMerge main-checkout preflight + branch restore (H3)", () => {
    /** Current branch of the main checkout ("" when detached). */
    function currentBranch(): string {
      const r = Bun.spawnSync(["git", "branch", "--show-current"], {
        cwd: repoDir,
        stdout: "pipe",
      });
      return (r.stdout?.toString() ?? "").trim();
    }

    it("refuses with DIRTY_MAIN_CHECKOUT on staged changes — and never commits them", async () => {
      const wt = manager.create("2026-09-01-dirty-main", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");

      // The user's unrelated staged work in the MAIN checkout.
      writeFileSync(join(repoDir, "staged.txt"), "user work\n");
      Bun.spawnSync(["git", "add", "staged.txt"], { cwd: repoDir });

      let caught: unknown;
      try {
        await manager.squashMerge(wt.id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorktreeError);
      expect((caught as WorktreeError).code).toBe("DIRTY_MAIN_CHECKOUT");
      expect((caught as WorktreeError).message).toContain("staged.txt");

      // The polluted-commit behaviour is GONE: no commit anywhere contains
      // staged.txt, and it is still staged and uncommitted in the checkout.
      const log = Bun.spawnSync(
        ["git", "log", "--all", "--oneline", "--", "staged.txt"],
        { cwd: repoDir, stdout: "pipe" },
      );
      expect((log.stdout?.toString() ?? "").trim()).toBe("");
      const status = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: repoDir,
        stdout: "pipe",
      });
      expect(status.stdout?.toString() ?? "").toContain("A  staged.txt");

      // Nothing was merged, nothing was removed, the slot is still held.
      expect(existsSync(join(repoDir, "feature.ts"))).toBe(false);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("allows untracked-only files in the main checkout — they cannot be committed", async () => {
      const wt = manager.create("2026-09-01-untracked-main", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");

      writeFileSync(join(repoDir, "scratch.txt"), "notes\n");

      const mergeCommit = await manager.squashMerge(wt.id);
      expect(wtStore.get(wt.id)!.status).toBe("merged");

      // The untracked file survives, untouched and still untracked.
      expect(readFileSync(join(repoDir, "scratch.txt"), "utf-8")).toBe(
        "notes\n",
      );
      const show = Bun.spawnSync(
        ["git", "show", "--stat", "--format=", mergeCommit],
        { cwd: repoDir, stdout: "pipe" },
      );
      expect(show.stdout?.toString() ?? "").not.toContain("scratch.txt");
    });

    it("restores the branch the user was on after a successful merge", async () => {
      const wt = manager.create("2026-09-01-restore", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");
      Bun.spawnSync(["git", "checkout", "-b", "side"], { cwd: repoDir });

      const mergeCommit = await manager.squashMerge(wt.id);

      expect(currentBranch()).toBe("side");
      // The merge still landed on the BASE branch, not on side.
      const mainHead = Bun.spawnSync(["git", "rev-parse", "main"], {
        cwd: repoDir,
        stdout: "pipe",
      });
      expect((mainHead.stdout?.toString() ?? "").trim()).toBe(mergeCommit);
    });

    it("no-ops the restore when the user was already on the base branch", async () => {
      const wt = manager.create("2026-09-01-on-base", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");
      expect(currentBranch()).toBe("main");

      await manager.squashMerge(wt.id);
      expect(currentBranch()).toBe("main");
    });

    it("restores the branch even when a failure happens AFTER the checkout", async () => {
      // Stage the same late-appearing-file failure the REMOVE_FAILED tests
      // use: the stop hook runs before the checkout, the removal fails after
      // the commit — a genuine post-checkout failure path.
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: async (worktreePath: string) => {
          writeFileSync(join(worktreePath, "appeared-late.txt"), "x");
          return { ok: true, stopped: false, actions: [], warnings: [] };
        },
      });
      const wt = m.create("2026-09-01-restore-fail", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");
      Bun.spawnSync(["git", "checkout", "-b", "side-fail"], { cwd: repoDir });

      await expect(m.squashMerge(wt.id)).rejects.toThrow(WorktreeError);

      // The merge landed (the failure was the removal), but the user is back
      // on the branch they were on.
      expect(currentBranch()).toBe("side-fail");
      expect(existsSync(wt.worktreePath)).toBe(true);
    });

    it("does not attempt a restore from a detached HEAD, and says so", async () => {
      const wt = manager.create("2026-09-01-detached", repoDir);
      addAndCommit(wt.worktreePath, "feature.ts", "export {};\n", "feat");
      Bun.spawnSync(["git", "checkout", "--detach"], { cwd: repoDir });
      expect(currentBranch()).toBe(""); // detached

      const warnings: string[] = [];
      await manager.squashMerge(wt.id, undefined, warnings);

      // Left on the base branch — there was no branch to go back to.
      expect(currentBranch()).toBe("main");
      expect(warnings.join("\n")).toContain("detached");
    });
  });

  describe("abandon", () => {
    it("should remove worktree and mark as abandoned", async () => {
      const wt = manager.create(undefined, repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);

      await manager.abandon(wt.id);

      expect(existsSync(wt.worktreePath)).toBe(false);
      const abandoned = wtStore.get(wt.id);
      expect(abandoned!.status).toBe("abandoned");
    });

    it("should throw for non-existent worktree", async () => {
      await expect(manager.abandon("nonexistent")).rejects.toThrow(
        WorktreeError,
      );
    });
  });

  // ─── Stop-on-exit (Task 5) ────────────────────────────────────────────────
  //
  // ⛔ `abandon` and `squashMerge` are the NORMAL end-of-spec exits, and both
  // remove the worktree from disk. A tracked process whose cwd has just been
  // deleted is exactly the orphan this tier exists to prevent — `worktree_cleanup`
  // is the least likely of the three to be the real exit path.

  describe("stop-on-exit", () => {
    /** A stop hook that records the state of the world at the moment it runs. */
    function recordingHook(ok = true) {
      const seen: { path: string; dirExisted: boolean; headBranch: string }[] =
        [];
      const fn = async (worktreePath: string) => {
        const head = Bun.spawnSync(
          ["git", "rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: repoDir, stdout: "pipe" },
        );
        seen.push({
          path: worktreePath,
          dirExisted: existsSync(worktreePath),
          headBranch: (head.stdout?.toString() ?? "").trim(),
        });
        return ok
          ? { ok: true, stopped: true, actions: [], warnings: [] }
          : {
              ok: false,
              stopped: false,
              actions: [],
              warnings: [],
              reason: "REFUSING to signal process group 4242.",
            };
      };
      return { fn, seen };
    }

    it("abandon stops the owned group BEFORE the directory is touched", async () => {
      const hook = recordingHook();
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: hook.fn,
      });
      const wt = m.create(undefined, repoDir);

      await m.abandon(wt.id);

      expect(hook.seen).toHaveLength(1);
      expect(hook.seen[0]!.path).toBe(wt.worktreePath);
      // ⛔ The ordering IS the requirement.
      expect(hook.seen[0]!.dirExisted).toBe(true);
      expect(existsSync(wt.worktreePath)).toBe(false);
    });

    it("abandon REFUSES to remove the directory when the stop failed", async () => {
      const hook = recordingHook(false);
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: hook.fn,
      });
      const wt = m.create(undefined, repoDir);

      // ⛔ `await` is load-bearing: an unawaited `.rejects` assertion never
      // runs, so this test would pass against an implementation that removed
      // the directory regardless.
      await expect(m.abandon(wt.id)).rejects.toThrow(/REFUSING/);

      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("squashMerge stops BEFORE `git checkout base`, not merely before remove", async () => {
      const hook = recordingHook();
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: hook.fn,
      });
      const wt = m.create("2026-08-09-stop-merge", repoDir);
      addAndCommit(wt.worktreePath, "x.ts", "x", "commit");
      // Put the main checkout somewhere other than the base branch, so a stop
      // that ran AFTER the checkout would be visibly distinguishable.
      Bun.spawnSync(["git", "checkout", "-b", "side"], { cwd: repoDir });

      await m.squashMerge(wt.id, "feat: merged");

      expect(hook.seen).toHaveLength(1);
      // A live process holding files can make the CHECKOUT itself fail, so the
      // stop has to precede it.
      expect(hook.seen[0]!.headBranch).toBe("side");
      expect(hook.seen[0]!.dirExisted).toBe(true);
    });

    it("squashMerge aborts the whole merge when the stop failed", async () => {
      const hook = recordingHook(false);
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: hook.fn,
      });
      const wt = m.create("2026-08-09-stop-merge-fail", repoDir);
      addAndCommit(wt.worktreePath, "y.ts", "y", "commit");

      await expect(m.squashMerge(wt.id)).rejects.toThrow(/REFUSING/);

      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
      expect(existsSync(join(repoDir, "y.ts"))).toBe(false);
    });

    // ── An ABSENT resolver is not the same thing as "nothing to stop" ───────
    //
    // ⛔ Every other decision in this tier fails CLOSED. A missing resolver
    // used to be the one exception: `manager.stopOwnedRuntime` returned early,
    // and `abandon` then removed a directory without stopping anything. That
    // is indistinguishable, from the manager's side, from a site that simply
    // forgot to wire the dep — which is why the only guard was a grep over
    // five known construction sites, and why any new or external site
    // inherited the unsafe default.

    it("REFUSES the exit path when no stop resolver was wired at all", async () => {
      // The cast IS the test: this is the shape an un-updated construction
      // site produces, and JS callers reach it without tsc's help.
      const unwired = {
        ...testConfig,
        stopOwnedRuntime: undefined,
      } as unknown as WorktreeConfig;
      const m = new WorktreeManager(wtStore, unwired);
      const wt = m.create("2026-08-20-unwired", repoDir);

      await expect(m.abandon(wt.id)).rejects.toThrow(/stopOwnedRuntime/);

      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(wtStore.get(wt.id)!.status).toBe("active");
    });

    it("REFUSES squashMerge too, before anything is merged", async () => {
      const unwired = {
        ...testConfig,
        stopOwnedRuntime: undefined,
      } as unknown as WorktreeConfig;
      const m = new WorktreeManager(wtStore, unwired);
      const wt = m.create("2026-08-20-unwired-merge", repoDir);
      addAndCommit(wt.worktreePath, "u.ts", "u", "commit");

      await expect(m.squashMerge(wt.id)).rejects.toThrow(/stopOwnedRuntime/);

      expect(wtStore.get(wt.id)!.status).toBe("active");
      expect(existsSync(join(repoDir, "u.ts"))).toBe(false);
    });

    it("proceeds when the opt-out is DECLARED rather than forgotten", async () => {
      // ⚠️ Scope: this covers the deliberate-opt-out branch — a manager that
      // states it has nothing to stop must behave exactly as it did before
      // Phase 4. It says NOTHING about Pre-Mortem #2 ("every `abandon` pays
      // `graceMs`"), which is a property of the REAL resolver and cannot be
      // tested from here: `src/worktree/**` may not import `src/runtime/**`, so
      // the only hook available in this file is a stub, and a stub short-
      // circuits because it was written to. The real proof — the declared
      // `down` is never executed — lives in
      // `src/runtime/worktree-deps.test.ts`.
      const m = new WorktreeManager(wtStore, {
        ...testConfig,
        stopOwnedRuntime: NO_RUNTIME_STOP,
      });
      const wt = m.create("2026-08-20-optout", repoDir);
      const started = Date.now();
      await m.abandon(wt.id);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(existsSync(wt.worktreePath)).toBe(false);
    });

    it("DEFAULT_WORKTREE_CONFIG opts out EXPLICITLY, so 'forgot' stays distinguishable", () => {
      // ⛔ The reason the sentinel exists at all: `DEFAULT_WORKTREE_CONFIG` is
      // what tests and inert callers build on, and making them all wire a stub
      // would be a tax paid by every test in the suite. Declaring the opt-out
      // once, here, keeps `undefined` meaning exactly one thing — "nobody
      // decided" — which is the case that must fail closed.
      expect(DEFAULT_WORKTREE_CONFIG.stopOwnedRuntime).toBe(NO_RUNTIME_STOP);
    });
  });

  // `cleanup` / `cleanup(force)` moved to `cleanup.test.ts` and
  // `resolveWithReconcile` to `reconcile.test.ts`, alongside the modules they
  // were extracted into. The assertions travelled verbatim.

  // ── Slots (Task 3: allocation, Task 4: emergent release) ───────────────────

  describe("slots", () => {
    describe("create()", () => {
      it("gives two worktrees in one project distinct slots, neither of them 0", () => {
        const a = manager.create("2026-08-07-slot-a", repoDir);
        const b = manager.create("2026-08-07-slot-b", repoDir);

        expect(a.slot).toBe(1);
        expect(b.slot).toBe(2);
        expect(a.slot).not.toBe(b.slot);
        expect(a.slot).not.toBe(MAIN_CHECKOUT_SLOT);
        expect(b.slot).not.toBe(MAIN_CHECKOUT_SLOT);
      });

      it("allocates 1..maxActive, and the (maxActive+1)th fails with MAX_ACTIVE — never SLOT_EXHAUSTED", () => {
        // testConfig.maxActive === 3
        const slots = [
          manager.create("2026-08-07-cap-1", repoDir).slot,
          manager.create("2026-08-07-cap-2", repoDir).slot,
          manager.create("2026-08-07-cap-3", repoDir).slot,
        ];
        expect(slots).toEqual([1, 2, 3]);

        let caught: unknown;
        try {
          manager.create("2026-08-07-cap-4", repoDir);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(WorktreeError);
        // While every held slot belongs to an ACTIVE row, countActive and the
        // pool agree, so the guard fires first. (They diverge once a row is
        // ready-to-merge — see the SLOT_EXHAUSTED test below.)
        expect((caught as WorktreeError).code).toBe("MAX_ACTIVE");
      });

      it("SLOT_EXHAUSTED IS reachable — ready-to-merge rows hold slots countActive does not count", () => {
        // ⚠️ The two bounds disagree by construction: the MAX_ACTIVE guard uses
        // countActive ('active' only) while the slot pool is scoped to the LIVE
        // set ('active' + 'ready-to-merge'). So a pool full of ready-to-merge
        // worktrees walks straight past the guard.
        const a = manager.create("2026-08-08-exhaust-1", repoDir);
        const b = manager.create("2026-08-08-exhaust-2", repoDir);
        manager.create("2026-08-08-exhaust-3", repoDir);
        wtStore.updateStatus(a.id, "ready-to-merge");
        wtStore.updateStatus(b.id, "ready-to-merge");

        expect(wtStore.countActive(repoDir)).toBe(1); // guard passes...
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1, 2, 3]); // ...pool full

        let caught: unknown;
        try {
          manager.create("2026-08-08-exhaust-4", repoDir);
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(WorktreeError);
        // A data-determined empty pool — NOT a transient lost race.
        expect((caught as WorktreeError).code).toBe("SLOT_EXHAUSTED");
        expect((caught as WorktreeError).message).toContain("worktree_cleanup");

        // The rollback envelope tore the git worktree back down: no directory,
        // no git registration, no DB row.
        const gitList = Bun.spawnSync(["git", "worktree", "list"], {
          cwd: repoDir,
        }).stdout.toString();
        expect(gitList).not.toContain("spec-2026-08-08-exhaust-4");
        expect(
          wtStore
            .listForProject(repoDir)
            .some((w) => w.branchName.includes("exhaust-4")),
        ).toBe(false);
      });

      it("persists the slot so a fresh manager/store sees it (sidecar builds one per request)", () => {
        const a = manager.create("2026-08-07-persist", repoDir);
        const fresh = new WorktreeManager(
          new WorktreeStore(memoryStore),
          testConfig,
        );
        expect(fresh.status(a.id).slot).toBe(a.slot);
      });

      it("does not leak the slot when the DB insert fails (rollback)", () => {
        const first = manager.create("2026-08-07-rollback-1", repoDir);
        expect(first.slot).toBe(1);

        // Force the next insert to fail for a reason unrelated to slots.
        const orig = wtStore.insert.bind(wtStore);
        let failed = false;
        wtStore.insert = ((wt: Parameters<typeof orig>[0]) => {
          if (!failed) {
            failed = true;
            throw new Error("simulated DB failure");
          }
          return orig(wt);
        }) as typeof wtStore.insert;

        expect(() => manager.create("2026-08-07-rollback-2", repoDir)).toThrow(
          "simulated DB failure",
        );
        wtStore.insert = orig;

        // The failed attempt must have left slot 2 free, and the git worktree
        // must have been rolled back too (otherwise countActive is wrong).
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1]);
        expect(manager.create("2026-08-07-rollback-3", repoDir).slot).toBe(2);
      });
    });

    describe("resolveWithReconcile()", () => {
      it("performs NO allocation when the live row already has a slot", () => {
        const a = manager.create("2026-08-07-noalloc", repoDir);
        expect(a.slot).toBe(1);

        const resolved = manager.resolveWithReconcile(
          "2026-08-07-noalloc",
          repoDir,
        );
        expect(resolved!.slot).toBe(1);
        expect(resolved!.id).toBe(a.id);
        // No extra row, no extra slot.
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1]);
      });

      it("lazily allocates for a pre-V12 live row carrying slot = null", () => {
        const a = manager.create("2026-08-07-lazy", repoDir);
        // Simulate a pre-V12 row: the column exists but was never populated.
        memoryStore
          .getRawDb()
          .prepare("UPDATE worktrees SET slot = NULL WHERE id = ?")
          .run(a.id);
        expect(wtStore.get(a.id)!.slot).toBeNull();

        const resolved = manager.resolveWithReconcile(
          "2026-08-07-lazy",
          repoDir,
        );
        expect(resolved!.slot).toBe(1);
        // ...and it is persisted, not just returned.
        expect(wtStore.get(a.id)!.slot).toBe(1);
      });

      it("re-registering an on-disk worktree REUSES the slot of the row it just abandoned", async () => {
        // Arrange so the prior slot is deliberately NOT the lowest free one,
        // otherwise "reuse" and "allocate lowest" are indistinguishable.
        const a = manager.create("2026-08-07-reuse-a", repoDir); // slot 1
        manager.create("2026-08-07-reuse-b", repoDir); // slot 2
        const c = manager.create("2026-08-07-reuse-c", repoDir); // slot 3
        await manager.abandon(a.id); // frees slot 1

        // Make c's recorded path stale while its git worktree survives — this
        // is the route that reaches the self-heal at manager.ts:319 and then
        // the re-registering insert.
        memoryStore
          .getRawDb()
          .prepare("UPDATE worktrees SET worktree_path = ? WHERE id = ?")
          .run(join(tmpDir, "gone"), c.id);

        const resolved = manager.resolveWithReconcile(
          "2026-08-07-reuse-c",
          repoDir,
        );
        expect(resolved).not.toBeNull();
        expect(resolved!.worktreePath).toBe(c.worktreePath);
        // Lowest-free would be 1. Reuse gives back 3 — the number the
        // directory's own seeded config was written against.
        expect(resolved!.slot).toBe(3);
        expect(wtStore.get(c.id)!.status).toBe("abandoned");
      });

      it("allocates fresh when there was no prior row to recover a slot from", () => {
        const a = manager.create("2026-08-07-fresh", repoDir);
        // Take slot 1 with a different, still-live worktree and destroy a's row.
        wtStore.delete(a.id);
        manager.create("2026-08-07-squatter", repoDir); // takes slot 1

        const resolved = manager.resolveWithReconcile(
          "2026-08-07-fresh",
          repoDir,
        );
        expect(resolved!.slot).toBe(2);
      });

      it("WARNS when the directory's own slot file disagrees with the slot it was handed", () => {
        // The recovery preference is best-effort: if the directory's own slot
        // is taken, insertWithSlot silently falls back to the lowest free one.
        // The directory then holds a `.env` interpolated against slot N and a
        // slot file declaring slot M — the exact port/DB collision this phase
        // exists to prevent, reachable through a plain worktree_detect.
        const a = manager.create("2026-08-08-mismatch", repoDir);
        expect(readSlotFromWorktree(a.worktreePath)).toBe(1);

        wtStore.delete(a.id); // lose the row → reconcile re-registers
        manager.create("2026-08-08-squatter", repoDir); // takes slot 1

        const warnings: string[] = [];
        const resolved = manager.resolveWithReconcile(
          "2026-08-08-mismatch",
          repoDir,
          warnings,
        );

        expect(resolved!.slot).toBe(2); // preferred 1 was taken
        const text = warnings.join("\n");
        // Names BOTH numbers and a remedy — "may point at the wrong resources"
        // is not enough when the disagreement is *known*.
        expect(text).toContain("slot 1");
        expect(text).toContain("slot 2");
        expect(text).toContain("re-run detection");
      });

      it("does NOT warn about a mismatch when the directory got the slot it asked for", () => {
        const a = manager.create("2026-08-08-nomismatch", repoDir);
        expect(readSlotFromWorktree(a.worktreePath)).toBe(1);
        wtStore.delete(a.id);

        const warnings: string[] = [];
        const resolved = manager.resolveWithReconcile(
          "2026-08-08-nomismatch",
          repoDir,
          warnings,
        );

        expect(resolved!.slot).toBe(1);
        expect(warnings.join("\n")).not.toContain("re-run detection");
      });

      it("returns slot = null WITH A WARNING rather than throwing when no slot is free", () => {
        // ⚠️ resolveWithReconcile has NO maxActive guard (create() does), so it
        // is the only realistic source of an empty pool. Fill 1..3, then add a
        // live, UNSLOTTED duplicate row for slug `full-a` whose recorded path is
        // stale — reconcile abandons it and re-registers the surviving
        // directory, at which point nothing is free.
        const a = manager.create("2026-08-07-full-a", repoDir);
        manager.create("2026-08-07-full-b", repoDir);
        manager.create("2026-08-07-full-c", repoDir);
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1, 2, 3]);

        memoryStore
          .getRawDb()
          .prepare(
            `INSERT INTO worktrees (id, spec_id, project_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, slot)
             VALUES ('dup', NULL, ?, ?, ?, 'main', 'abc', 'active', ?, NULL)`,
          )
          .run(
            repoDir,
            join(tmpDir, "gone"),
            a.branchName,
            Date.now() + 100_000,
          );

        const warnings: string[] = [];
        let resolved: ReturnType<typeof manager.resolveWithReconcile>;
        expect(() => {
          resolved = manager.resolveWithReconcile(
            "2026-08-07-full-a",
            repoDir,
            warnings,
          );
        }).not.toThrow();

        // ⛔ A read-shaped "where is my worktree" call must never hard-fail.
        expect(resolved!).not.toBeNull();
        expect(resolved!.slot).toBeNull();
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.join("\n")).toContain("slot");
      });
    });

    // ── Lazy allocation (ensureSlot) — the SECOND write path ────────────────
    // `insertWithSlot` wraps allocate+insert in BEGIN IMMEDIATE with a retry.
    // `ensureSlot` is the other place a slot is written (pre-V12 rows), and it
    // sits on the `worktree_detect` READ path, which must never throw.
    describe("lazy allocation is atomic (ensureSlot)", () => {
      /** Turn `a` into a pre-V12 row: live, on disk, but carrying slot = NULL. */
      function makePreV12(slug: string): string {
        const a = manager.create(slug, repoDir);
        memoryStore
          .getRawDb()
          .prepare("UPDATE worktrees SET slot = NULL WHERE id = ?")
          .run(a.id);
        expect(wtStore.get(a.id)!.slot).toBeNull();
        return a.id;
      }

      /**
       * A competing process commits `slot` for this project from a SECOND
       * connection — i.e. after our snapshot of the free slots was taken.
       */
      function competitorTakes(slot: number): void {
        const other = new MemoryStore(join(dbDir, "test.db"));
        try {
          new WorktreeStore(other).insert({
            id: `competitor-${slot}`,
            projectPath: repoDir,
            worktreePath: join(tmpDir, `competitor-${slot}`),
            branchName: `sentinal/spec-competitor-${slot}`,
            baseBranch: "main",
            baseCommit: "abc123",
            status: "active",
            createdAt: Date.now(),
            slot,
          });
        } finally {
          other.close();
        }
      }

      /**
       * A store whose free-slot view is STALE — the competitor's committed row
       * is invisible to it. `staleAttempts = Infinity` never recovers; `1` means
       * only the first transaction attempt sees the stale view.
       */
      function staleViewManager(staleAttempts: number): WorktreeManager {
        let attempts = 0;
        const spy = new Proxy(wtStore, {
          get(target, prop, recv) {
            if (prop === "runImmediate") {
              return <T>(fn: () => T): T => {
                attempts++;
                return target.runImmediate(fn);
              };
            }
            if (prop === "listLiveSlots") {
              return (p: string) =>
                attempts <= staleAttempts ? [] : target.listLiveSlots(p);
            }
            return Reflect.get(target, prop, recv);
          },
        }) as unknown as WorktreeStore;
        return new WorktreeManager(spy, testConfig);
      }

      it("⛔ does NOT throw when a competitor took the slot between the SELECT and the UPDATE", () => {
        const id = makePreV12("2026-08-08-lazy-race-lost");
        competitorTakes(1);

        // Every attempt sees the stale view, so every UPDATE violates
        // idx_wt_slot_live. A raw SQLITE_CONSTRAINT_UNIQUE escaping here turns
        // a read-shaped `worktree_detect` into an error.
        const racy = staleViewManager(Number.POSITIVE_INFINITY);
        const warnings: string[] = [];
        let resolved: ReturnType<typeof manager.resolveWithReconcile> = null;

        expect(() => {
          resolved = racy.resolveWithReconcile(
            "2026-08-08-lazy-race-lost",
            repoDir,
            warnings,
          );
        }).not.toThrow();

        // Degrades to "no slot" + a warning — never a thrown constraint.
        expect(resolved!).not.toBeNull();
        expect(resolved!.slot).toBeNull();
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.join("\n").toLowerCase()).toContain("slot");
        // The row is left unslotted, not corrupted.
        expect(wtStore.get(id)!.slot).toBeNull();
        // ...and the competitor keeps slot 1.
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1]);
      });

      it("RETRIES a lost race and still assigns a distinct slot", () => {
        const id = makePreV12("2026-08-08-lazy-race-won");
        competitorTakes(1);

        const racy = staleViewManager(1); // only the first attempt is stale
        const warnings: string[] = [];
        const resolved = racy.resolveWithReconcile(
          "2026-08-08-lazy-race-won",
          repoDir,
          warnings,
        );

        // Attempt 1 asked for slot 1 and lost; attempt 2 saw the truth.
        expect(resolved!.slot).toBe(2);
        expect(wtStore.get(id)!.slot).toBe(2);
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1, 2]);
      });
    });

    // ── Task 4: one test per exit path out of the LIVE set ─────────────────

    describe("release is emergent — one test per exit path", () => {
      it("abandon() frees the slot, and the next create() gets it", async () => {
        const a = manager.create("2026-08-07-rel-abandon", repoDir);
        expect(a.slot).toBe(1);
        await manager.abandon(a.id);

        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
        expect(manager.create("2026-08-07-rel-next", repoDir).slot).toBe(1);
        // The record of which slot it held survives — reconcile needs it.
        expect(wtStore.get(a.id)!.slot).toBe(1);
      });

      it("squashMerge() frees the slot", async () => {
        const a = manager.create("2026-08-07-rel-merge", repoDir);
        addAndCommit(a.worktreePath, "x.ts", "export const x = 1;\n", "work");
        await manager.squashMerge(a.id);

        expect(wtStore.get(a.id)!.status).toBe("merged");
        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
        expect(manager.create("2026-08-07-rel-merge-2", repoDir).slot).toBe(1);
      });

      it("cleanup() (directory gone) frees the slot", () => {
        const a = manager.create("2026-08-07-rel-cleanup", repoDir);
        rmSync(a.worktreePath, { recursive: true, force: true });

        expect(manager.cleanup()).toBe(1);
        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
        expect(manager.create("2026-08-07-rel-cleanup-2", repoDir).slot).toBe(
          1,
        );
      });

      it("forceCleanupOrphans() (via cleanup({force})) frees the slot", () => {
        const a = manager.create("2026-08-07-rel-force", repoDir);
        expect(a.slot).toBe(1);

        manager.cleanup({
          force: true,
          projectPath: repoDir,
          isPlanActive: () => false,
          // Guard 5 fails CLOSED: without a liveness resolver the whole force
          // pass is refused, so a test about slot release has to state the
          // verdict it is releasing under.
          ownsLiveRuntime: () => ({ live: false }),
        });

        expect(wtStore.get(a.id)!.status).toBe("abandoned");
        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
      });

      it("resolveWithReconcile() self-heal (directory gone) frees the slot", () => {
        const a = manager.create("2026-08-07-rel-selfheal", repoDir);
        rmSync(a.worktreePath, { recursive: true, force: true });

        // Directory is gone AND git no longer has it → nothing to re-register.
        Bun.spawnSync(["git", "worktree", "prune"], { cwd: repoDir });
        const resolved = manager.resolveWithReconcile(
          "2026-08-07-rel-selfheal",
          repoDir,
        );
        expect(resolved).toBeNull();
        expect(wtStore.get(a.id)!.status).toBe("abandoned");
        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
      });

      it("store.delete() frees the slot (it removes the index entry outright)", () => {
        const a = manager.create("2026-08-07-rel-delete", repoDir);
        expect(wtStore.delete(a.id)).toBe(true);
        expect(wtStore.listLiveSlots(repoDir)).toEqual([]);
      });

      it("⛔ ready-to-merge does NOT free the slot — the worktree is still live on disk", () => {
        const a = manager.create("2026-08-07-rel-rtm", repoDir);
        expect(a.slot).toBe(1);
        wtStore.updateStatus(a.id, "ready-to-merge");

        // Its directory, its seeded config and (Phase 4) its processes all still
        // exist. Freeing slot 1 here is the exact port/DB collision this phase
        // prevents.
        expect(existsSync(a.worktreePath)).toBe(true);
        expect(wtStore.listLiveSlots(repoDir)).toEqual([1]);
        expect(manager.create("2026-08-07-rel-rtm-2", repoDir).slot).toBe(2);
      });
    });
  });

  // ── Task 5: isolated config seeding, wired into the lifecycle ────────────

  describe("config seeding (D8)", () => {
    /** Commit `.env.example` so the worktree's HEAD is realistic. */
    function commitExample(content: string): void {
      addAndCommit(repoDir, ".env.example", content, "add env example");
    }

    it("create() seeds .env from .env.example with the allocated slot", () => {
      commitExample(`PORT=30${SLOT_PLACEHOLDER}0\n`);

      const wt = manager.create("2026-08-07-seed", repoDir);

      expect(wt.slot).toBe(1);
      expect(readFileSync(join(wt.worktreePath, ".env"), "utf-8")).toBe(
        "PORT=3010\n",
      );
    });

    it("create() writes the sourceable slot env file", () => {
      const wt = manager.create("2026-08-07-seed-slotfile", repoDir);

      expect(
        readFileSync(join(wt.worktreePath, SLOT_ENV_RELATIVE_PATH), "utf-8"),
      ).toContain("SENTINAL_WORKTREE_SLOT=1");
      expect(readSlotFromWorktree(wt.worktreePath)).toBe(1);
    });

    it("create() surfaces seeding warnings to the caller", () => {
      const warnings: string[] = [];
      manager.create("2026-08-07-seed-warn", repoDir, undefined, warnings);

      // No .env.example in this repo — that must be loud, not silent.
      expect(warnings.join("\n")).toContain(".env.example");
    });

    it("create() does NOT overwrite a .env that came from HEAD", () => {
      // A repo that (unwisely) commits its .env: `git worktree add` checks it
      // out, so seeding meets a pre-existing file even on the create path.
      addAndCommit(repoDir, ".env", "FROM_HEAD=yes\n", "commit env");
      commitExample(`PORT=30${SLOT_PLACEHOLDER}0\n`);

      const warnings: string[] = [];
      const wt = manager.create(
        "2026-08-07-seed-head",
        repoDir,
        undefined,
        warnings,
      );

      expect(readFileSync(join(wt.worktreePath, ".env"), "utf-8")).toBe(
        "FROM_HEAD=yes\n",
      );
      expect(warnings.join("\n")).toContain(".env");
    });

    it("reconcile does NOT overwrite a hand-edited .env", () => {
      commitExample(`PORT=30${SLOT_PLACEHOLDER}0\n`);
      const a = manager.create("2026-08-07-seed-recon", repoDir);
      writeFileSync(join(a.worktreePath, ".env"), "HAND_EDITED=yes\n");

      // Lose the DB row so reconcile takes the re-registering insert path.
      wtStore.delete(a.id);
      const resolved = manager.resolveWithReconcile(
        "2026-08-07-seed-recon",
        repoDir,
      );

      expect(resolved).not.toBeNull();
      expect(readFileSync(join(a.worktreePath, ".env"), "utf-8")).toBe(
        "HAND_EDITED=yes\n",
      );
    });

    it("an I/O failure while seeding rolls back BOTH the worktree and the DB row", () => {
      // A genuine WRITE failure, staged deterministically: commit a DIRECTORY
      // at the slot env file's path, so `git worktree add` checks it out and
      // writeFileSync hits EISDIR.
      // ⚠️ Deliberately NOT an unreadable `.env.example` — a source that cannot
      // be READ is treated as missing (warn + continue), because destroying a
      // healthy worktree over a file we only wanted to copy is a bad trade.
      // Only write failures are fatal.
      mkdirSync(join(repoDir, ".sentinal", "worktree.env"), {
        recursive: true,
      });
      addAndCommit(
        repoDir,
        join(".sentinal", "worktree.env", "keep"),
        "x\n",
        "commit a directory where the slot file goes",
      );

      expect(() => manager.create("2026-08-07-seed-boom", repoDir)).toThrow();

      expect(wtStore.listForProject(repoDir)).toEqual([]);
      expect(
        existsSync(join(repoDir, ".sentinal", "worktrees")) &&
          Bun.spawnSync(["git", "worktree", "list"], { cwd: repoDir })
            .stdout.toString()
            .includes("spec-2026-08-07-seed-boom"),
      ).toBe(false);
    });

    it("leaves `git status` clean inside the new worktree", () => {
      commitExample(`PORT=30${SLOT_PLACEHOLDER}0\n`);
      const wt = manager.create("2026-08-07-seed-clean", repoDir);

      const status = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: wt.worktreePath,
      })
        .stdout.toString()
        .trim();
      expect(status).toBe("");
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
