/**
 * Merge location (D3) and external merge (D2) — `docs/plans/2026-09-28-orca-orchestration.md`
 * Task 7. Real git fixtures throughout: the thing under test is which checkout
 * receives the commit, and what survives on disk.
 *
 * - The base branch checked out in a linked worktree (an Orca coordinator's
 *   checkout) → the squash lands THERE; the main checkout is not touched.
 * - That holder dirty with tracked edits → DIRTY_MAIN_CHECKOUT naming the
 *   checkout, the files and the remedy; nothing merged.
 * - The base checked out nowhere → the main checkout, as before.
 * - `owner === "external"` → squash, strip seeded files, mark `merged`; the
 *   directory and branch survive.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { seedWorktreeConfig } from "./worktree-config.js";
import {
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  WorktreeError,
  type Worktree,
  type WorktreeConfig,
} from "./types.js";

const TIMEOUT = 30_000;

function git(args: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim() };
}

function commitFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  git(["add", name], dir);
  git(["commit", "-m", `add ${name}`], dir);
}

function branchExists(repo: string, branch: string): boolean {
  return (
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)
      .code === 0
  );
}

const config: WorktreeConfig = {
  enabled: true,
  directory: ".sentinal/worktrees",
  branchPrefix: "sentinal/spec-",
  maxActive: 5,
  autoCleanup: true,
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
};

describe("squashMerge — merge location (D3) and external merge (D2)", () => {
  let tmp: string;
  let repo: string;
  let coord: string;
  let memory: MemoryStore;
  let store: WorktreeStore;
  let manager: WorktreeManager;

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("sentinal-merge"));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "test@test.com"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFileSync(join(repo, "README.md"), "# Test\n");
    writeFileSync(
      join(repo, ".env.example"),
      "PORT=40${SENTINAL_WORKTREE_SLOT}\n",
    );
    git(["add", "."], repo);
    git(["commit", "-m", "initial commit"], repo);
    // The coordinator's checkout: a linked worktree holding branch `coord`.
    coord = join(tmp, "coord");
    expect(git(["worktree", "add", "-b", "coord", coord], repo).code).toBe(0);
    mkdirSync(join(tmp, "db"), { recursive: true });
    memory = new MemoryStore(join(tmp, "db", "test.db"));
    store = new WorktreeStore(memory);
    manager = new WorktreeManager(store, config);
  });

  afterEach(() => {
    memory.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "base checked out in a clean linked worktree → the commit lands there; main checkout untouched",
    async () => {
      const mainHead = git(["rev-parse", "HEAD"], repo).out;
      const wt = manager.create("2026-09-28-child", coord, "coord");
      commitFile(wt.worktreePath, "feature.ts", "export {};\n");

      const result = await manager.squashMergeDetailed(wt.id, "feat: child");

      expect(result.mergedIn).toBe(coord);
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(git(["rev-parse", "coord"], repo).out).toBe(result.commit);
      expect(git(["rev-parse", "HEAD"], coord).out).toBe(result.commit);
      expect(git(["branch", "--show-current"], coord).out).toBe("coord");
      expect(existsSync(join(coord, "feature.ts"))).toBe(true);
      // The main checkout: same branch, same HEAD, no file.
      expect(git(["branch", "--show-current"], repo).out).toBe("main");
      expect(git(["rev-parse", "HEAD"], repo).out).toBe(mainHead);
      expect(existsSync(join(repo, "feature.ts"))).toBe(false);
      // Sentinal-owned: removed and merged, as before.
      expect(existsSync(wt.worktreePath)).toBe(false);
      expect(branchExists(repo, wt.branchName)).toBe(false);
      expect(store.get(wt.id)!.status).toBe("merged");
    },
    TIMEOUT,
  );

  it(
    "holder dirty → DIRTY_MAIN_CHECKOUT naming the checkout, the files and the remedy; nothing merged",
    async () => {
      const wt = manager.create("2026-09-28-dirty-holder", coord, "coord");
      commitFile(wt.worktreePath, "feature.ts", "export {};\n");
      const coordTip = git(["rev-parse", "coord"], repo).out;
      // The coordinator's uncommitted checkbox edit.
      writeFileSync(join(coord, "README.md"), "# Test\n- [x] phase 1\n");

      let caught: unknown;
      try {
        await manager.squashMerge(wt.id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorktreeError);
      expect((caught as WorktreeError).code).toBe("DIRTY_MAIN_CHECKOUT");
      const msg = (caught as WorktreeError).message;
      expect(msg).toContain(coord);
      expect(msg).toContain("README.md");
      expect(msg).toContain("commit or stash them");
      expect(msg).toContain("coordinator should commit its plan edits");
      expect(msg).toContain("Nothing has been merged");

      expect(git(["rev-parse", "coord"], repo).out).toBe(coordTip);
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(store.get(wt.id)!.status).toBe("active");
    },
    TIMEOUT,
  );

  it(
    "a dirty MAIN checkout does not block a merge that lands in the holder",
    async () => {
      const wt = manager.create("2026-09-28-main-dirty", coord, "coord");
      commitFile(wt.worktreePath, "feature.ts", "export {};\n");
      writeFileSync(join(repo, "README.md"), "# user edit in main\n");

      const result = await manager.squashMergeDetailed(wt.id);

      expect(result.mergedIn).toBe(coord);
      expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe(
        "# user edit in main\n",
      );
    },
    TIMEOUT,
  );

  it(
    "base checked out nowhere → the main checkout, restored to its branch",
    async () => {
      git(["branch", "develop"], repo);
      const wt = manager.create("2026-09-28-nowhere", repo, "develop");
      commitFile(wt.worktreePath, "feature.ts", "export {};\n");

      const result = await manager.squashMergeDetailed(wt.id);

      expect(result.mergedIn).toBe(repo);
      expect(git(["rev-parse", "develop"], repo).out).toBe(result.commit);
      expect(git(["branch", "--show-current"], repo).out).toBe("main");
      expect(git(["branch", "--show-current"], coord).out).toBe("coord");
      expect(store.get(wt.id)!.status).toBe("merged");
    },
    TIMEOUT,
  );

  it(
    "squashMerge still returns the commit hash (back-compat)",
    async () => {
      const wt = manager.create("2026-09-28-compat", repo);
      commitFile(wt.worktreePath, "feature.ts", "export {};\n");
      const commit = await manager.squashMerge(wt.id);
      expect(commit).toBe(git(["rev-parse", "main"], repo).out);
    },
    TIMEOUT,
  );

  describe("external worktrees", () => {
    /** An Orca-style child off `coord`, adopted as external and seeded. */
    function externalChild(): Worktree {
      const path = join(tmp, "orca", "child");
      mkdirSync(join(tmp, "orca"), { recursive: true });
      expect(
        git(["worktree", "add", "-b", "orca/child", path, "coord"], repo).code,
      ).toBe(0);
      const wtPath = realpathSync(path);
      const row = store.insert({
        id: "ext-1",
        specId: null,
        projectPath: repo,
        worktreePath: wtPath,
        branchName: "orca/child",
        baseBranch: "coord",
        baseCommit: git(["rev-parse", "coord"], repo).out,
        status: "active",
        slot: 1,
        owner: "external",
        slug: "child",
        createdAt: Date.now(),
      });
      seedWorktreeConfig({ repoRoot: repo, worktreePath: wtPath, slot: 1 });
      expect(existsSync(join(wtPath, ".sentinal/worktree.env"))).toBe(true);
      expect(existsSync(join(wtPath, ".env"))).toBe(true);
      commitFile(wtPath, "phase.ts", "export const phase = 1;\n");
      return row;
    }

    it(
      "commits into the holder, keeps dir + branch, strips seeded files, marks merged",
      async () => {
        const wt = externalChild();

        const warnings: string[] = [];
        const result = await manager.squashMergeDetailed(
          wt.id,
          "feat: phase",
          warnings,
        );

        expect(result.mergedIn).toBe(coord);
        expect(result.outcome).toBe("released");
        expect(git(["rev-parse", "coord"], repo).out).toBe(result.commit);
        expect(existsSync(join(coord, "phase.ts"))).toBe(true);
        // ⛔ The external directory and branch survive.
        expect(existsSync(wt.worktreePath)).toBe(true);
        expect(existsSync(join(wt.worktreePath, "phase.ts"))).toBe(true);
        expect(branchExists(repo, "orca/child")).toBe(true);
        const listed = git(["worktree", "list", "--porcelain"], repo).out;
        expect(listed).toContain(wt.worktreePath);
        // Seeded files stripped.
        expect(
          existsSync(join(wt.worktreePath, ".sentinal/worktree.env")),
        ).toBe(false);
        expect(existsSync(join(wt.worktreePath, ".env"))).toBe(false);
        const after = store.get(wt.id)!;
        expect(after.status).toBe("merged");
        expect(after.mergeCommit).toBe(result.commit);
        expect(warnings).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      "Sentinal-owned merges report outcome 'removed'",
      async () => {
        const wt = manager.create("2026-09-28-owned", coord, "coord");
        commitFile(wt.worktreePath, "feature.ts", "export {};\n");
        const result = await manager.squashMergeDetailed(wt.id);
        expect(result.outcome).toBe("removed");
      },
      TIMEOUT,
    );
  });
});
