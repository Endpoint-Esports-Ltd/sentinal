/**
 * Reconcile (slug → worktree, disk-authoritative) + lazy slot assurance.
 *
 * Extracted verbatim from `manager.test.ts` (`resolveWithReconcile` :444) when
 * `reconcile.ts` was split out of `manager.ts`. Assertions unchanged — the
 * extraction claims byte-identical behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { resolveWithReconcile, ensureSlot } from "./reconcile.js";
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

describe("resolveWithReconcile", () => {
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

  it("should return the existing record when index and disk agree", () => {
    const wt = manager.create("2026-06-09-agree", repoDir);

    const resolved = manager.resolveWithReconcile("2026-06-09-agree", repoDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(wt.id);
    expect(wtStore.countActive(repoDir)).toBe(1);
  });

  it("should re-register a worktree that exists on disk but is missing from the index", () => {
    const wt = manager.create("2026-06-09-drift", repoDir);
    wtStore.delete(wt.id);
    expect(wtStore.resolveBySlug("2026-06-09-drift", repoDir)).toBeNull();

    const resolved = manager.resolveWithReconcile("2026-06-09-drift", repoDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.branchName).toBe(wt.branchName);
    expect(resolved!.worktreePath).toBe(wt.worktreePath);
    expect(resolved!.status).toBe("active");
    expect(wtStore.countActive(repoDir)).toBe(1);
  });

  it("should re-register a worktree whose record was wrongly marked abandoned", () => {
    const wt = manager.create("2026-06-09-wrong-status", repoDir);
    wtStore.updateStatus(wt.id, "abandoned");

    const resolved = manager.resolveWithReconcile(
      "2026-06-09-wrong-status",
      repoDir,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.worktreePath).toBe(wt.worktreePath);
    expect(resolved!.status).toBe("active");
  });

  it("should mark abandoned and return null when the directory is gone", () => {
    const wt = manager.create("2026-06-09-gone", repoDir);
    rmSync(wt.worktreePath, { recursive: true, force: true });
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: repoDir });
    Bun.spawnSync(["git", "branch", "-D", wt.branchName], { cwd: repoDir });

    const resolved = manager.resolveWithReconcile("2026-06-09-gone", repoDir);
    expect(resolved).toBeNull();
    expect(wtStore.get(wt.id)!.status).toBe("abandoned");
  });

  it("should return null for a slug with no record and nothing on disk", () => {
    const resolved = manager.resolveWithReconcile("no-such-slug", repoDir);
    expect(resolved).toBeNull();
  });

  it("should return null when no project path is available for a disk scan", () => {
    const resolved = manager.resolveWithReconcile("no-such-slug");
    expect(resolved).toBeNull();
  });

  // ── D1: exact-match disk scan (prefix collision) ──────────────────────────
  //
  // Branches are NEVER suffixed — only the row id and the worktree path carry
  // the `-<hash>` (established by v1.36.2's H4). A `startsWith` arm therefore
  // matches nothing a `===` misses, but it DOES match a *different* slug that
  // happens to extend the wanted one — and reconcile would then adopt (and
  // re-register) the wrong worktree for the asked-for slug.
  it("D1: a disk scan for slug `add` does NOT adopt branch `sentinal/spec-add-auth`", () => {
    const wt = manager.create("add-auth", repoDir);
    // Drop the row so ANY resolve for a matching branch takes the disk-scan
    // re-register path.
    wtStore.delete(wt.id);

    // `add` is a strict prefix of `add-auth` → wanted branch
    // `sentinal/spec-add` prefix-matches `sentinal/spec-add-auth`.
    const resolved = manager.resolveWithReconcile("add", repoDir);
    expect(resolved).toBeNull();

    // The true owner still reconciles.
    const real = manager.resolveWithReconcile("add-auth", repoDir);
    expect(real).not.toBeNull();
    expect(real!.branchName).toBe(wt.branchName);
    expect(real!.worktreePath).toBe(wt.worktreePath);
  });

  // ── The extracted free functions, called directly ─────────────────────────

  it("resolveWithReconcile is what the manager delegates to", () => {
    const wt = manager.create("2026-08-08-direct", repoDir);

    const resolved = resolveWithReconcile(
      wtStore,
      testConfig,
      "2026-08-08-direct",
      repoDir,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(wt.id);
  });

  it("ensureSlot returns the row untouched when it already has a slot", () => {
    const wt = manager.create("2026-08-08-hasslot", repoDir);
    expect(wt.slot).not.toBeNull();

    const warnings: string[] = [];
    const same = ensureSlot(wtStore, testConfig, wt, warnings);
    expect(same.slot).toBe(wt.slot!);
    expect(warnings).toEqual([]);
  });

  it("ensureSlot lazily allocates for a pre-V12 row carrying slot = null", () => {
    const wt = manager.create("2026-08-08-noslot", repoDir);
    // Simulate a pre-V12 row: the DB row exists, but the caller hands us a
    // record carrying no slot (that is exactly what `store.get` returns for a
    // row written before migration V12).
    const bare = { ...wt, slot: null };

    const warnings: string[] = [];
    const healed = ensureSlot(wtStore, testConfig, bare, warnings);
    expect(healed.slot).toBeGreaterThan(0);
  });

  // ── R11 (Task 6): the OTHER TWO seed sites ────────────────────────────────
  //
  // `create.ts` carries the first `seedWorktreeConfig` call; both of the
  // `seedNonFatally` calls live here. Pre-Mortem #3 is precisely "one site was
  // missed", so each is asserted on its own.

  describe("R11 shared-resource injection", () => {
    function seedSourceWithoutPlaceholder(): void {
      writeFileSync(
        join(repoDir, ".env.example"),
        "DATABASE_URL=postgres://x\n",
      );
      Bun.spawnSync(["git", "add", "-A"], { cwd: repoDir });
      Bun.spawnSync(["git", "commit", "-m", "seed source"], { cwd: repoDir });
    }

    it("names shared resources on the RE-REGISTER seed site", () => {
      seedSourceWithoutPlaceholder();
      const wt = manager.create("2026-08-09-r11-rereg", repoDir);
      // Rule 0 never overwrites an existing `.env`, so the re-seed would be a
      // skip (and emit no isolation warning at all) unless create()'s output is
      // cleared first. Removing it is what makes THIS site's seed the one under
      // test rather than create()'s.
      rmSync(join(wt.worktreePath, ".env"), { force: true });
      // Drop the row so reconcile has to re-register from disk — that is the
      // branch carrying the first `seedNonFatally`.
      wtStore.delete(wt.id);

      const warnings: string[] = [];
      resolveWithReconcile(
        wtStore,
        { ...testConfig, sharedResourcesFor: () => ["database"] },
        "2026-08-09-r11-rereg",
        repoDir,
        warnings,
      );
      expect(
        warnings.some((w) =>
          w.includes("Shared with the main checkout: database."),
        ),
      ).toBe(true);
    });

    it("names shared resources on the ensureSlot seed site", () => {
      seedSourceWithoutPlaceholder();
      const wt = manager.create("2026-08-09-r11-ensure", repoDir);
      rmSync(join(wt.worktreePath, ".env"), { force: true });
      const bare = { ...wt, slot: null };

      const warnings: string[] = [];
      ensureSlot(
        wtStore,
        { ...testConfig, sharedResourcesFor: () => ["queue"] },
        bare,
        warnings,
      );
      expect(
        warnings.some((w) =>
          w.includes("Shared with the main checkout: queue."),
        ),
      ).toBe(true);
    });

    it("resolves each site against ITS OWN worktree path", () => {
      seedSourceWithoutPlaceholder();
      const wt = manager.create("2026-08-09-r11-paths", repoDir);
      const seen: string[] = [];
      ensureSlot(
        wtStore,
        {
          ...testConfig,
          sharedResourcesFor: (p) => {
            seen.push(p);
            return [];
          },
        },
        { ...wt, slot: null },
        [],
      );
      expect(seen).toEqual([wt.worktreePath]);
    });
  });
});
