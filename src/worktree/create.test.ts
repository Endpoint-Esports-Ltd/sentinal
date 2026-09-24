/**
 * `createWorktree` — the git-add + insert-with-slot + seed rollback envelope,
 * extracted verbatim from `manager.ts` so the manager stays under its budget.
 *
 * `manager.test.ts`'s `describe("create")` still exercises the same behaviour
 * through `WorktreeManager.create`, which now delegates here. These tests cover
 * the free function directly.
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
import { createWorktree } from "./create.js";
import {
  WorktreeError,
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

describe("createWorktree", () => {
  let tmpDir: string;
  let repoDir: string;
  let dbDir: string;
  let memoryStore: MemoryStore;
  let wtStore: WorktreeStore;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    dbDir = join(tmpDir, "db");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    initRepo(repoDir);
    memoryStore = new MemoryStore(join(dbDir, "test.db"));
    wtStore = new WorktreeStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the branch, the directory and the DB row", () => {
    const wt = createWorktree(
      wtStore,
      testConfig,
      "2026-08-08-create",
      repoDir,
    );

    expect(wt.branchName).toBe("sentinal/spec-2026-08-08-create");
    expect(wt.baseBranch).toBe("main");
    expect(wt.status).toBe("active");
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(wtStore.get(wt.id)!.id).toBe(wt.id);
  });

  it("assigns a slot and collects seeding warnings in the caller's array", () => {
    const warnings: string[] = [];
    const wt = createWorktree(
      wtStore,
      testConfig,
      "2026-08-08-warn",
      repoDir,
      undefined,
      warnings,
    );
    expect(wt.slot).toBeGreaterThan(0);
    expect(Array.isArray(warnings)).toBe(true);
  });

  /**
   * R11 (Task 6): the shared-resource names reach `notIsolatedWarning` as
   * DATA, via `config.sharedResourcesFor`. `src/worktree/**` may not import
   * `src/runtime/**` (`src/runtime/no-module-cycle.test.ts`), so the resolver
   * is a plain function supplied by whoever constructed the manager.
   */
  describe("R11 shared-resource injection", () => {
    /** A seed source with NO slot placeholder — the only path that warns. */
    function seedSourceWithoutPlaceholder(): void {
      writeFileSync(
        join(repoDir, ".env.example"),
        "DATABASE_URL=postgres://x\n",
      );
      Bun.spawnSync(["git", "add", "-A"], { cwd: repoDir });
      Bun.spawnSync(["git", "commit", "-m", "seed source"], { cwd: repoDir });
    }

    it("names the declared shared resources in the seeding warning", () => {
      seedSourceWithoutPlaceholder();
      const warnings: string[] = [];
      createWorktree(
        wtStore,
        { ...testConfig, sharedResourcesFor: () => ["database", "cache"] },
        "2026-08-09-r11-named",
        repoDir,
        undefined,
        warnings,
      );
      const notIsolated = warnings.find((w) => w.includes("NOT isolated"));
      expect(notIsolated).toBeDefined();
      expect(notIsolated).toContain(
        "Shared with the main checkout: database, cache.",
      );
    });

    it("is byte-identical to the Phase 2 baseline when no resolver is injected", () => {
      seedSourceWithoutPlaceholder();

      const baseline: string[] = [];
      createWorktree(
        wtStore,
        testConfig,
        "2026-08-09-r11-baseline",
        repoDir,
        undefined,
        baseline,
      );

      const empty: string[] = [];
      createWorktree(
        wtStore,
        { ...testConfig, sharedResourcesFor: () => [] },
        "2026-08-09-r11-empty",
        repoDir,
        undefined,
        empty,
      );

      expect(empty).toEqual(baseline);
      expect(
        baseline.some((w) => w.includes("Shared with the main checkout")),
      ).toBe(false);
    });

    it("resolves against the WORKTREE path, not the repo root", () => {
      seedSourceWithoutPlaceholder();
      const seen: string[] = [];
      const wt = createWorktree(
        wtStore,
        {
          ...testConfig,
          sharedResourcesFor: (p) => {
            seen.push(p);
            return [];
          },
        },
        "2026-08-09-r11-path",
        repoDir,
        undefined,
        [],
      );
      expect(seen).toContain(wt.worktreePath);
      expect(seen).not.toContain(repoDir);
    });
  });

  it("refuses when the branch already exists", () => {
    createWorktree(wtStore, testConfig, "2026-08-08-dup", repoDir);
    expect(() =>
      createWorktree(wtStore, testConfig, "2026-08-08-dup", repoDir),
    ).toThrow(WorktreeError);
  });

  it("enforces maxActive", () => {
    const cfg: WorktreeConfig = { ...testConfig, maxActive: 1 };
    createWorktree(wtStore, cfg, "2026-08-08-a", repoDir);
    expect(() => createWorktree(wtStore, cfg, "2026-08-08-b", repoDir)).toThrow(
      /Maximum active worktrees/,
    );
  });

  // ── Task 13: un-nesting ────────────────────────────────────────────────────
  //
  // Before, a worktree created from inside a LINKED worktree (e.g. an Orca
  // checkout) was nested under `<linked>/.sentinal/worktrees/`, keyed by the
  // linked path, and recorded the linked checkout's HEAD as its base commit.
  describe("from a linked worktree (Task 13)", () => {
    let linked: string;

    function git(args: string[], cwd: string): string {
      const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" });
      return (r.stdout?.toString() ?? "").trim();
    }

    beforeEach(() => {
      linked = join(tmpDir, "linked");
      git(["worktree", "add", "-b", "orca-support", linked], repoDir);
      // The linked checkout moves ahead of main, so its HEAD ≠ main's commit.
      writeFileSync(join(linked, "ahead.txt"), "ahead\n");
      git(["add", "."], linked);
      git(["commit", "-m", "linked ahead"], linked);
    });

    it("lands under the MAIN checkout with the canonical project key", () => {
      const wt = createWorktree(wtStore, testConfig, "2026-09-24-un", linked);

      expect(
        wt.worktreePath.startsWith(
          join(repoDir, ".sentinal", "worktrees") + "/",
        ),
      ).toBe(true);
      expect(wt.projectPath).toBe(repoDir);
      expect(wtStore.get(wt.id)!.projectPath).toBe(repoDir);
      expect(existsSync(wt.worktreePath)).toBe(true);
      // Nothing nested under the linked checkout.
      expect(existsSync(join(linked, ".sentinal", "worktrees"))).toBe(false);
    }, 15_000);

    it("records the BASE branch's commit, not the invoking checkout's HEAD", () => {
      const wt = createWorktree(
        wtStore,
        testConfig,
        "2026-09-24-base",
        linked,
        "main",
      );
      expect(wt.baseCommit).toBe(git(["rev-parse", "main"], repoDir));
      expect(wt.baseCommit).not.toBe(git(["rev-parse", "HEAD"], linked));
      // …and the worktree really branched from it.
      expect(git(["rev-parse", "HEAD"], wt.worktreePath)).toBe(wt.baseCommit);
    }, 15_000);

    it("records the base commit from the main checkout too, when it sits on another branch", () => {
      git(["checkout", "-b", "side"], repoDir);
      writeFileSync(join(repoDir, "side.txt"), "side\n");
      git(["add", "."], repoDir);
      git(["commit", "-m", "side"], repoDir);

      const wt = createWorktree(
        wtStore,
        testConfig,
        "2026-09-24-side",
        repoDir,
        "main",
      );
      expect(wt.baseCommit).toBe(git(["rev-parse", "main"], repoDir));
    }, 15_000);

    it("refuses a base that does not resolve — clearly, and leaves nothing behind", () => {
      let caught: unknown;
      try {
        createWorktree(
          wtStore,
          testConfig,
          "2026-09-24-nobase",
          linked,
          "no-such-base",
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WorktreeError);
      expect((caught as Error).message).toContain("no-such-base");
      expect(wtStore.listAll()).toHaveLength(0);
      expect(
        git(["branch", "--list", "sentinal/spec-2026-09-24-nobase"], repoDir),
      ).toBe("");
    }, 15_000);

    it("counts legacy rows keyed by the linked checkout toward maxActive", () => {
      wtStore.insert({
        id: "legacy-1",
        specId: undefined,
        projectPath: linked, // how earlier versions keyed a create-from-linked
        worktreePath: join(linked, ".sentinal", "worktrees", "spec-legacy-1"),
        branchName: "sentinal/spec-legacy",
        baseBranch: "main",
        baseCommit: "0".repeat(40),
        status: "active",
        createdAt: Date.now() - 1000,
        slot: 1,
      });
      const cfg: WorktreeConfig = { ...testConfig, maxActive: 1 };
      expect(() =>
        createWorktree(wtStore, cfg, "2026-09-24-max", repoDir),
      ).toThrow(/Maximum active worktrees/);
    }, 15_000);

    it("seeds from the MAIN checkout, the same root the worktree lives under", () => {
      // An untracked seed source present ONLY in the main checkout.
      writeFileSync(join(repoDir, ".env.example"), "PORT=3000\n");
      const warnings: string[] = [];
      createWorktree(
        wtStore,
        testConfig,
        "2026-09-24-seed",
        linked,
        undefined,
        warnings,
      );
      expect(warnings.some((w) => w.includes("No .env.example found"))).toBe(
        false,
      );
    }, 15_000);
  });
});
