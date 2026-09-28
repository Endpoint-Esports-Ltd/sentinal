/**
 * `ensureWorktree` (orca D4) — create-or-adopt, against REAL git repos.
 *
 * The "Orca-style" worktree is a plain `git worktree add <tmp>/orca-x -b orca-x
 * <base>`: a linked worktree Sentinal did not create, on a branch with no
 * Sentinal prefix, outside `.sentinal/worktrees`.
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
import { ensureWorktree } from "./adopt.js";
import type { WorktreeSetupRunner, WorktreeSetupOutcome } from "./create.js";
import {
  WorktreeError,
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  type WorktreeConfig,
} from "./types.js";

const T = 30_000;

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

const testConfig: WorktreeConfig = {
  enabled: true,
  directory: ".sentinal/worktrees",
  branchPrefix: "sentinal/spec-",
  maxActive: 3,
  autoCleanup: true,
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
};

const OK: WorktreeSetupOutcome = {
  ran: true,
  ok: true,
  exitCode: 0,
  timedOut: false,
  tail: "",
};

function recordingSetup(result: WorktreeSetupOutcome = OK) {
  const calls: Array<{ path: string; slot: number | null }> = [];
  const run: WorktreeSetupRunner = async (path, slot) => {
    calls.push({ path, slot });
    return result;
  };
  return { calls, run };
}

async function rejects(p: Promise<unknown>): Promise<WorktreeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(WorktreeError);
    return err as WorktreeError;
  }
  throw new Error("expected a rejection");
}

describe("ensureWorktree", () => {
  let tmp: string;
  let repo: string;
  let orca: string;
  let memoryStore: MemoryStore;
  let store: WorktreeStore;

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("sentinal-adopt"));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# r\n");
    writeFileSync(
      join(repo, ".env.example"),
      "PORT=40${SENTINAL_WORKTREE_SLOT}\n",
    );
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    git(["branch", "coord"], repo);
    orca = join(tmp, "orca-x");
    git(["worktree", "add", orca, "-b", "orca-x", "coord"], repo);
    writeFileSync(join(orca, "work.txt"), "w\n");
    git(["add", "."], orca);
    git(["commit", "-m", "orca work"], orca);
    mkdirSync(join(tmp, "db"));
    memoryStore = new MemoryStore(join(tmp, "db", "test.db"));
    store = new WorktreeStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("adopting an external worktree", () => {
    it(
      "records owner, slug and slot, seeds, runs setup once; a second call returns the same row",
      async () => {
        const setup = recordingSetup();
        const warnings: string[] = [];
        const wt = await ensureWorktree(
          store,
          testConfig,
          {
            slug: "2026-09-28-phase-1",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
            setup: setup.run,
          },
          warnings,
        );
        expect(wt.adopted).toBe(true);
        expect(wt.created).toBe(false);
        expect(wt.existing).toBe(false);
        expect(wt.owner).toBe("external");
        expect(wt.slug).toBe("2026-09-28-phase-1");
        expect(wt.branchName).toBe("orca-x");
        expect(wt.baseBranch).toBe("coord");
        expect(wt.baseCommit).toBe(git(["rev-parse", "coord"], repo));
        expect(wt.worktreePath).toBe(orca);
        expect(wt.projectPath).toBe(repo);
        expect(wt.slot).toBeGreaterThan(0);
        expect(readFileSync(join(orca, ".env"), "utf-8")).toBe(
          `PORT=40${wt.slot}\n`,
        );
        expect(
          readFileSync(join(orca, ".sentinal", "worktree.env"), "utf-8"),
        ).toContain(`SENTINAL_WORKTREE_SLOT=${wt.slot}`);
        expect(setup.calls).toEqual([{ path: orca, slot: wt.slot ?? null }]);
        expect(wt.setup).toEqual(OK);
        expect(store.get(wt.id)?.owner).toBe("external");

        const again = await ensureWorktree(store, testConfig, {
          slug: "2026-09-28-phase-1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
          setup: setup.run,
        });
        expect(again.existing).toBe(true);
        expect(again.adopted).toBe(false);
        expect(again.id).toBe(wt.id);
        expect(again.slot).toBe(wt.slot);
        expect(setup.calls.length).toBe(1); // setup runs ONCE
        expect(
          store.listAll().filter((r) => r.status === "active").length,
        ).toBe(1);
      },
      T,
    );

    it(
      "finds the adopted row from a linked checkout too (project scoping)",
      async () => {
        const first = await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
        });
        const again = await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: orca,
          path: orca,
          base: "coord",
          owner: "external",
        });
        expect(again.id).toBe(first.id);
        expect(again.existing).toBe(true);
      },
      T,
    );

    it(
      "refuses the same path under a different slug — never silently re-owns",
      async () => {
        await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
        });
        const err = await rejects(
          ensureWorktree(store, testConfig, {
            slug: "p2",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
          }),
        );
        expect(err.code).toBe("ALREADY_EXISTS");
      },
      T,
    );

    it(
      "refuses the same slug with a different owner",
      async () => {
        await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
        });
        const err = await rejects(
          ensureWorktree(store, testConfig, {
            slug: "p1",
            project: repo,
            path: orca,
            base: "coord",
            owner: "sentinal",
          }),
        );
        expect(err.code).toBe("ALREADY_EXISTS");
        expect(store.listAll()[0]?.owner).toBe("external");
      },
      T,
    );

    it(
      "refuses the same slug bound to a different path",
      async () => {
        await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
        });
        const other = join(tmp, "orca-y");
        git(["worktree", "add", other, "-b", "orca-y", "coord"], repo);
        const err = await rejects(
          ensureWorktree(store, testConfig, {
            slug: "p1",
            project: repo,
            path: other,
            base: "coord",
            owner: "external",
          }),
        );
        expect(err.code).toBe("ALREADY_EXISTS");
      },
      T,
    );
  });

  describe("refusals — nothing recorded", () => {
    const refuse = async (
      over: Partial<Parameters<typeof ensureWorktree>[2]>,
    ) => {
      const err = await rejects(
        ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
          ...over,
        }),
      );
      expect(store.listAll()).toEqual([]);
      return err;
    };

    it(
      "a path that is not a worktree of the repo",
      async () => {
        const stray = join(tmp, "stray");
        mkdirSync(stray);
        const err = await refuse({ path: stray });
        expect(err.code).toBe("NOT_FOUND");
        expect(err.message).toContain(stray);
      },
      T,
    );

    it(
      "a worktree of ANOTHER repository, even on a branch",
      async () => {
        const other = join(tmp, "other");
        mkdirSync(other);
        git(["init", "-b", "main"], other);
        git(["config", "user.email", "t@t.com"], other);
        git(["config", "user.name", "T"], other);
        writeFileSync(join(other, "x"), "x\n");
        git(["add", "."], other);
        git(["commit", "-m", "x"], other);
        const foreign = join(tmp, "foreign");
        git(["worktree", "add", foreign, "-b", "foreign"], other);
        expect((await refuse({ path: foreign, base: "main" })).code).toBe(
          "NOT_FOUND",
        );
      },
      T,
    );

    it(
      "the main checkout",
      async () => {
        const err = await refuse({ path: repo, base: "coord" });
        expect(err.message).toContain("main checkout");
      },
      T,
    );

    it(
      "a worktree whose branch IS the base",
      async () => {
        const err = await refuse({ base: "orca-x" });
        expect(err.message).toContain("base");
      },
      T,
    );

    it(
      "owner external without a base",
      async () => {
        const err = await refuse({ base: undefined });
        expect(err.message).toContain("base");
      },
      T,
    );

    it(
      "owner external without a path",
      async () => {
        await refuse({ path: undefined });
      },
      T,
    );

    it(
      "a base that does not resolve",
      async () => {
        expect((await refuse({ base: "nope" })).code).toBe("GIT_ERROR");
      },
      T,
    );

    it(
      "a project that is not a repository",
      async () => {
        const plain = join(tmp, "plain");
        mkdirSync(plain);
        expect((await refuse({ project: plain })).code).toBe("NOT_A_REPO");
      },
      T,
    );

    it(
      "MAX_ACTIVE, the same policy as create",
      async () => {
        const full = { ...testConfig, maxActive: 0 };
        const err = await rejects(
          ensureWorktree(store, full, {
            slug: "p1",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
          }),
        );
        expect(err.code).toBe("MAX_ACTIVE");
      },
      T,
    );
  });

  describe("failures after insert", () => {
    it(
      "a seeding failure deletes ONLY the row — the directory and branch survive",
      async () => {
        const boom: WorktreeConfig = {
          ...testConfig,
          sharedResourcesFor: () => {
            throw new Error("seed exploded");
          },
        };
        const err = await ensureWorktree(store, boom, {
          slug: "p1",
          project: repo,
          path: orca,
          base: "coord",
          owner: "external",
        }).catch((e: unknown) => e);
        expect((err as Error).message).toContain("seed exploded");
        expect(store.listAll()).toEqual([]);
        expect(existsSync(join(orca, "work.txt"))).toBe(true);
        expect(git(["branch", "--list", "orca-x"], repo)).toContain("orca-x");
      },
      T,
    );

    it(
      "a throwing setup is a warning: row, directory and branch all stay",
      async () => {
        const warnings: string[] = [];
        const wt = await ensureWorktree(
          store,
          testConfig,
          {
            slug: "p1",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
            setup: async () => {
              throw new Error("installer crashed");
            },
          },
          warnings,
        );
        expect(wt.setup?.ok).toBe(false);
        expect(warnings.some((w) => w.includes("installer crashed"))).toBe(
          true,
        );
        expect(store.get(wt.id)?.status).toBe("active");
        expect(existsSync(join(orca, "work.txt"))).toBe(true);
      },
      T,
    );

    it(
      "a failed setup (non-zero exit) is a warning naming the exit and tail",
      async () => {
        const warnings: string[] = [];
        const setup = recordingSetup({
          ran: true,
          ok: false,
          exitCode: 7,
          timedOut: false,
          tail: "lockfile mismatch",
        });
        const wt = await ensureWorktree(
          store,
          testConfig,
          {
            slug: "p1",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
            setup: setup.run,
          },
          warnings,
        );
        const w = warnings.find((x) => x.includes("lockfile mismatch"));
        expect(w).toBeDefined();
        expect(w).toContain("7");
        expect(store.get(wt.id)?.status).toBe("active");
      },
      T,
    );
  });

  describe("no path, owner sentinal → reconcile-then-create", () => {
    it(
      "creates a Sentinal worktree, runs setup once, then returns it as existing",
      async () => {
        const setup = recordingSetup();
        const wt = await ensureWorktree(store, testConfig, {
          slug: "2026-09-28-solo",
          project: repo,
          setup: setup.run,
        });
        expect(wt.created).toBe(true);
        expect(wt.owner).toBe("sentinal");
        expect(wt.branchName).toBe("sentinal/spec-2026-09-28-solo");
        expect(existsSync(wt.worktreePath)).toBe(true);
        expect(setup.calls).toEqual([
          { path: wt.worktreePath, slot: wt.slot ?? null },
        ]);

        const again = await ensureWorktree(store, testConfig, {
          slug: "2026-09-28-solo",
          project: repo,
          setup: setup.run,
        });
        expect(again.existing).toBe(true);
        expect(again.id).toBe(wt.id);
        expect(setup.calls.length).toBe(1);
      },
      T,
    );

    it(
      "a failing setup on create is a warning and never removes the worktree",
      async () => {
        const warnings: string[] = [];
        const wt = await ensureWorktree(
          store,
          testConfig,
          {
            slug: "solo",
            project: repo,
            setup: async () => {
              throw new Error("no network");
            },
          },
          warnings,
        );
        expect(existsSync(wt.worktreePath)).toBe(true);
        expect(store.get(wt.id)?.status).toBe("active");
        expect(warnings.some((w) => w.includes("no network"))).toBe(true);
      },
      T,
    );

    it(
      "adopting a path as owner sentinal requires takeover: true (it could be deleted later)",
      async () => {
        await expect(
          ensureWorktree(store, testConfig, {
            slug: "p1",
            project: repo,
            path: orca,
          }),
        ).rejects.toThrow(/takeover/);
        expect(store.listAll()).toHaveLength(0);
        const wt = await ensureWorktree(store, testConfig, {
          slug: "p1",
          project: repo,
          path: orca,
          takeover: true,
        });
        expect(wt.adopted).toBe(true);
        expect(wt.owner).toBe("sentinal");
        expect(wt.baseBranch).toBe("main");
      },
      T,
    );
  });

  describe("config.runSetup — the injected default runner (Task 9)", () => {
    it(
      "adopt falls back to config.runSetup when no explicit setup is passed",
      async () => {
        const setup = recordingSetup();
        const wt = await ensureWorktree(
          store,
          { ...testConfig, runSetup: setup.run },
          {
            slug: "cfg-adopt",
            project: repo,
            path: orca,
            base: "coord",
            owner: "external",
          },
        );
        expect(setup.calls).toEqual([{ path: orca, slot: wt.slot ?? null }]);
        expect(wt.setup).toEqual(OK);
      },
      T,
    );

    it(
      "create falls back to config.runSetup when no explicit setup is passed",
      async () => {
        const setup = recordingSetup();
        const wt = await ensureWorktree(
          store,
          { ...testConfig, runSetup: setup.run },
          { slug: "cfg-create", project: repo },
        );
        expect(wt.created).toBe(true);
        expect(setup.calls).toEqual([
          { path: wt.worktreePath, slot: wt.slot ?? null },
        ]);
      },
      T,
    );

    it(
      "an explicit setup wins over config.runSetup",
      async () => {
        const fromConfig = recordingSetup();
        const explicit = recordingSetup();
        await ensureWorktree(
          store,
          { ...testConfig, runSetup: fromConfig.run },
          { slug: "cfg-explicit", project: repo, setup: explicit.run },
        );
        expect(explicit.calls.length).toBe(1);
        expect(fromConfig.calls.length).toBe(0);
      },
      T,
    );
  });
});
