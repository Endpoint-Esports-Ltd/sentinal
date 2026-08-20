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
      writeFileSync(join(repoDir, ".env.example"), "DATABASE_URL=postgres://x\n");
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
      expect(notIsolated).toContain("Shared with the main checkout: database, cache.");
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
      expect(baseline.some((w) => w.includes("Shared with the main checkout"))).toBe(
        false,
      );
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
});
