/**
 * Ownership-safe abandon (D2 of docs/plans/2026-09-28-orca-orchestration.md).
 *
 * An `owner === "external"` worktree (Orca's, say) is RELEASED, never removed:
 * Sentinal stops only its own runtime, strips only the files it seeded, and
 * marks the row terminal. The directory, the branch and any uncommitted work
 * must survive. Real git fixtures throughout — the thing under test is what
 * happens on disk.
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
import { abandonWorktree } from "./abandon.js";
import { seedWorktreeConfig } from "./worktree-config.js";
import {
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  WorktreeError,
  type RuntimeStopOutcome,
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

function initRepo(dir: string): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  // A slot-aware seed source, so a seeded `.env` is distinguishable.
  writeFileSync(
    join(dir, ".env.example"),
    "PORT=40${SENTINAL_WORKTREE_SLOT}\nDB=app_${SENTINAL_WORKTREE_SLOT}\n",
  );
  git(["add", "."], dir);
  git(["commit", "-m", "initial commit"], dir);
}

function config(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
  return {
    enabled: true,
    directory: ".sentinal/worktrees",
    branchPrefix: "sentinal/spec-",
    maxActive: 5,
    autoCleanup: true,
    stopOwnedRuntime: NO_RUNTIME_STOP,
    unknownSentinalTokens: NO_TOKEN_CHECK,
    ...overrides,
  };
}

function branchExists(repo: string, branch: string): boolean {
  return (
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)
      .code === 0
  );
}

function gitWorktreePaths(repo: string): string[] {
  return git(["worktree", "list", "--porcelain"], repo)
    .out.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => realpathSync(l.slice("worktree ".length)));
}

describe("abandon — external worktrees are released, never removed", () => {
  let tmp: string;
  let repo: string;
  let memory: MemoryStore;
  let store: WorktreeStore;

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("sentinal-abandon"));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    mkdirSync(join(tmp, "db"), { recursive: true });
    memory = new MemoryStore(join(tmp, "db", "test.db"));
    store = new WorktreeStore(memory);
  });

  afterEach(() => {
    memory.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * An Orca-style worktree made with plain `git worktree add`, registered as
   * `external` at slot 1, seeded by Sentinal, holding uncommitted work.
   */
  function externalWorktree(
    path: string,
    branch: string,
    owner: Worktree["owner"] = "external",
  ): Worktree {
    mkdirSync(join(path, ".."), { recursive: true });
    expect(
      git(["worktree", "add", "-b", branch, path, "main"], repo).code,
    ).toBe(0);
    const wtPath = realpathSync(path);
    writeFileSync(join(wtPath, "work.txt"), "uncommitted work\n");
    const row = store.insert({
      id: `wt-${Math.random().toString(36).slice(2)}`,
      specId: null,
      projectPath: repo,
      worktreePath: wtPath,
      branchName: branch,
      baseBranch: "main",
      baseCommit: git(["rev-parse", "main"], repo).out,
      status: "active",
      slot: 1,
      owner,
      slug: "feature-x",
      createdAt: Date.now(),
    });
    seedWorktreeConfig({ repoRoot: repo, worktreePath: wtPath, slot: 1 });
    // Precondition: seeding really wrote what the release must strip.
    expect(existsSync(join(wtPath, ".sentinal/worktree.env"))).toBe(true);
    expect(readFileSync(join(wtPath, ".env"), "utf-8")).toContain("PORT=401");
    return row;
  }

  it(
    "outside .sentinal/worktrees: dir, branch and uncommitted work survive; seeded files go; row abandoned",
    async () => {
      const wt = externalWorktree(join(tmp, "orca", "feature-x"), "feature-x");
      const manager = new WorktreeManager(store, config());

      const result = await manager.abandon(wt.id);

      expect(result.outcome).toBe("released");
      expect(result.message).toContain(
        "released (external worktree left in place)",
      );
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect(readFileSync(join(wt.worktreePath, "work.txt"), "utf-8")).toBe(
        "uncommitted work\n",
      );
      expect(branchExists(repo, "feature-x")).toBe(true);
      expect(gitWorktreePaths(repo)).toContain(wt.worktreePath);
      // Seeded, unchanged → stripped, along with Sentinal's own ignore files.
      expect(existsSync(join(wt.worktreePath, ".sentinal/worktree.env"))).toBe(
        false,
      );
      expect(existsSync(join(wt.worktreePath, ".env"))).toBe(false);
      expect(existsSync(join(wt.worktreePath, ".gitignore"))).toBe(false);
      expect(existsSync(join(wt.worktreePath, ".sentinal"))).toBe(false);
      expect(store.get(wt.id)!.status).toBe("abandoned");
    },
    TIMEOUT,
  );

  it(
    "inside .sentinal/worktrees on a sentinal/spec- branch: still released (owner decides, not path)",
    async () => {
      const wt = externalWorktree(
        join(repo, ".sentinal", "worktrees", "spec-orca-1"),
        "sentinal/spec-orca-1",
      );
      const result = await new WorktreeManager(store, config()).abandon(wt.id);

      expect(result.outcome).toBe("released");
      expect(existsSync(join(wt.worktreePath, "work.txt"))).toBe(true);
      expect(branchExists(repo, "sentinal/spec-orca-1")).toBe(true);
      expect(store.get(wt.id)!.status).toBe("abandoned");
    },
    TIMEOUT,
  );

  it(
    "a .env edited since seeding is left in place, with its ignore entry, and a warning",
    async () => {
      const wt = externalWorktree(join(tmp, "orca", "feature-x"), "feature-x");
      writeFileSync(join(wt.worktreePath, ".env"), "PORT=9999\n");

      const result = await abandonWorktree(store, config(), wt.id);

      expect(result.outcome).toBe("released");
      expect(readFileSync(join(wt.worktreePath, ".env"), "utf-8")).toBe(
        "PORT=9999\n",
      );
      // Still hidden from git — the `/.env` line must survive.
      expect(git(["check-ignore", "-q", ".env"], wt.worktreePath).code).toBe(0);
      expect(result.warnings.join("\n")).toMatch(/\.env.*left in place/);
      expect(existsSync(join(wt.worktreePath, ".sentinal/worktree.env"))).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  it(
    "a .env that existed before seeding (Sentinal skipped it) is not removed",
    async () => {
      const path = join(tmp, "orca", "feature-x");
      mkdirSync(join(tmp, "orca"), { recursive: true });
      git(["worktree", "add", "-b", "feature-x", path, "main"], repo);
      const wtPath = realpathSync(path);
      writeFileSync(join(wtPath, ".env"), "OWNED_BY_ORCA=1\n");
      const row = store.insert({
        id: "wt-preexisting",
        specId: null,
        projectPath: repo,
        worktreePath: wtPath,
        branchName: "feature-x",
        baseBranch: "main",
        baseCommit: git(["rev-parse", "main"], repo).out,
        status: "active",
        slot: 1,
        owner: "external",
        createdAt: Date.now(),
      });
      seedWorktreeConfig({ repoRoot: repo, worktreePath: wtPath, slot: 1 });

      await abandonWorktree(store, config(), row.id);

      expect(readFileSync(join(wtPath, ".env"), "utf-8")).toBe(
        "OWNED_BY_ORCA=1\n",
      );
    },
    TIMEOUT,
  );

  it(
    "an ignore file Sentinal did not create is never rewritten",
    async () => {
      const path = join(tmp, "orca", "feature-x");
      mkdirSync(join(tmp, "orca"), { recursive: true });
      git(["worktree", "add", "-b", "feature-x", path, "main"], repo);
      const wtPath = realpathSync(path);
      // Orca's own untracked .gitignore; seeding appends to it.
      writeFileSync(join(wtPath, ".gitignore"), "node_modules\n");
      const row = store.insert({
        id: "wt-foreign-ignore",
        specId: null,
        projectPath: repo,
        worktreePath: wtPath,
        branchName: "feature-x",
        baseBranch: "main",
        baseCommit: git(["rev-parse", "main"], repo).out,
        status: "active",
        slot: 1,
        owner: "external",
        createdAt: Date.now(),
      });
      seedWorktreeConfig({ repoRoot: repo, worktreePath: wtPath, slot: 1 });
      const before = readFileSync(join(wtPath, ".gitignore"), "utf-8");

      await abandonWorktree(store, config(), row.id);

      expect(readFileSync(join(wtPath, ".gitignore"), "utf-8")).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "a TRACKED ignore file is never rewritten, even one carrying Sentinal's header",
    async () => {
      // Someone committed a Sentinal-written .gitignore into the repo.
      const committed =
        "# Written by Sentinal for this worktree only. Self-ignoring: not part of the repo.\n" +
        "/.gitignore\n/.env\n";
      writeFileSync(join(repo, ".gitignore"), committed);
      git(["add", "-f", ".gitignore"], repo);
      git(["commit", "-m", "commit ignore"], repo);
      const wt = externalWorktree(join(tmp, "orca", "feature-x"), "feature-x");

      await abandonWorktree(store, config(), wt.id);

      expect(existsSync(join(wt.worktreePath, ".env"))).toBe(false);
      expect(readFileSync(join(wt.worktreePath, ".gitignore"), "utf-8")).toBe(
        committed,
      );
    },
    TIMEOUT,
  );

  it(
    "a TRACKED .env is never removed, even when it equals the rendered template",
    async () => {
      const rendered = "PORT=401\nDB=app_1\n"; // slot 1 of .env.example
      writeFileSync(join(repo, ".env"), rendered);
      git(["add", "-f", ".env"], repo);
      git(["commit", "-m", "commit env"], repo);
      const path = join(tmp, "orca", "feature-x");
      mkdirSync(join(tmp, "orca"), { recursive: true });
      git(["worktree", "add", "-b", "feature-x", path, "main"], repo);
      const wtPath = realpathSync(path);
      const row = store.insert({
        id: "wt-tracked-env",
        specId: null,
        projectPath: repo,
        worktreePath: wtPath,
        branchName: "feature-x",
        baseBranch: "main",
        baseCommit: git(["rev-parse", "main"], repo).out,
        status: "active",
        slot: 1,
        owner: "external",
        createdAt: Date.now(),
      });

      await abandonWorktree(store, config(), row.id);

      expect(readFileSync(join(wtPath, ".env"), "utf-8")).toBe(rendered);
      expect(git(["status", "--porcelain"], wtPath).out).toBe("");
    },
    TIMEOUT,
  );

  it(
    "stops Sentinal's own runtime first, and a failed stop aborts the release",
    async () => {
      const wt = externalWorktree(join(tmp, "orca", "feature-x"), "feature-x");
      const calls: string[] = [];
      const failing = config({
        stopOwnedRuntime: async (p: string): Promise<RuntimeStopOutcome> => {
          calls.push(p);
          return {
            ok: false,
            stopped: false,
            actions: [],
            warnings: [],
            reason: "ownership unverifiable",
          };
        },
      });

      let err: unknown;
      try {
        await abandonWorktree(store, failing, wt.id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe("RUNTIME_STOP_FAILED");
      expect(calls).toEqual([wt.worktreePath]);
      // Nothing stripped, nothing marked.
      expect(existsSync(join(wt.worktreePath, ".sentinal/worktree.env"))).toBe(
        true,
      );
      expect(store.get(wt.id)!.status).toBe("active");
    },
    TIMEOUT,
  );

  it(
    "an external row whose directory is already gone is just marked abandoned; branch survives",
    async () => {
      const wt = externalWorktree(join(tmp, "orca", "feature-x"), "feature-x");
      rmSync(wt.worktreePath, { recursive: true, force: true });

      const result = await abandonWorktree(store, config(), wt.id);

      expect(result.outcome).toBe("released");
      expect(branchExists(repo, "feature-x")).toBe(true);
      expect(store.get(wt.id)!.status).toBe("abandoned");
    },
    TIMEOUT,
  );

  it(
    "control: a sentinal-owned row (owner absent) is still removed with its branch",
    async () => {
      const manager = new WorktreeManager(store, config());
      const wt = manager.create(undefined, repo);

      const result = await manager.abandon(wt.id);

      expect(result.outcome).toBe("removed");
      expect(existsSync(wt.worktreePath)).toBe(false);
      expect(branchExists(repo, wt.branchName)).toBe(false);
      expect(store.get(wt.id)!.status).toBe("abandoned");
    },
    TIMEOUT,
  );

  it("NOT_FOUND for an unknown id", async () => {
    await expect(abandonWorktree(store, config(), "nope")).rejects.toThrow(
      /not found/,
    );
  });
});
