/**
 * Worktree CLI Command Tests
 *
 * Tests for the new worktree CLI subcommands:
 *   - detect: Find worktree by slug
 *   - create: Create worktree for a slug
 *   - sync: Squash-merge a worktree by slug
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeTmpDir } from "../../test-helpers.js";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";
import { WorktreeStore } from "../../worktree/store.js";

// --- Helpers ---

function createSpec(
  tmpDir: string,
  memoryStore: MemoryStore,
  specId: string,
): void {
  const plansDir = join(tmpDir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${specId}.md`);
  writeFileSync(planFile, `# Test Spec\n\nStatus: PENDING\nType: Feature\n`);
  const specStore = new SpecStore(memoryStore);
  specStore.syncFromPlanFile(planFile, "/test/project");
}

// --- Tests ---

describe("worktree CLI detect subcommand", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should resolve slug via WorktreeStore.resolveBySlug", () => {
    createSpec(tmpDir, store, "test-plan");
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-detect-1",
      specId: "test-plan",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "test-plan"),
      branchName: "spec/test-plan",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const result = wtStore.resolveBySlug("test-plan", tmpDir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("wt-detect-1");
  });

  it("should return null when no worktree exists for slug", () => {
    const wtStore = new WorktreeStore(store);
    const result = wtStore.resolveBySlug("nonexistent", tmpDir);
    expect(result).toBeNull();
  });
});

describe("worktree CLI --json carries the slot (Task 6)", () => {
  let tmpDir: string;
  let repoDir: string;

  /**
   * Run the real CLI with an isolated HOME so `new MemoryStore()` picks a temp
   * DB instead of the developer's `~/.sentinal`. Spawning the binary (rather
   * than calling the action) is the point: it is the shape a script consumes.
   */
  function cli(args: string[]): Record<string, unknown> {
    const r = Bun.spawnSync(
      ["bun", "run", "src/cli/index.ts", "worktree", ...args],
      {
        cwd: resolve(import.meta.dir, "..", "..", ".."),
        env: { ...process.env, HOME: tmpDir },
      },
    );
    const out = new TextDecoder().decode(r.stdout).trim();
    const lastLine = out.split("\n").filter(Boolean).pop() ?? "";
    return JSON.parse(lastLine) as Record<string, unknown>;
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# t\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The `cli/commands/worktree.ts:48` construction site (R11, Task 6).
   *
   * Spawning the real binary is the point: `createManager()` is private, so the
   * only honest way to assert that IT injects `sharedResourcesFor` is to drive
   * the command a user would run and read the warnings it emits.
   */
  it("create --json names the runtime contract's shared resources", () => {
    mkdirSync(join(repoDir, ".sentinal"), { recursive: true });
    // No ${SENTINAL_WORKTREE_SLOT} placeholder — the only seed path that warns.
    writeFileSync(join(repoDir, ".env.example"), "DATABASE_URL=postgres://x\n");
    writeFileSync(
      join(repoDir, ".sentinal", "runtime.json"),
      JSON.stringify({ isolation: { database: "shared" } }),
    );
    // Committed so `git worktree add` gives the worktree its own copy — that
    // copy is what `sharedResourcesFor(worktreePath)` reads.
    Bun.spawnSync(["git", "add", "-Af"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "runtime contract"], { cwd: repoDir });

    const created = cli([
      "create",
      "2026-08-09-cli-r11",
      "--project",
      repoDir,
      "--json",
    ]);
    expect(created.error).toBeUndefined();
    expect((created.warnings as string[]).join("\n")).toContain(
      "Shared with the main checkout: database.",
    );
  }, 120_000);

  it("create --json and detect --json both report the slot", () => {
    const created = cli([
      "create",
      "2026-08-07-cli-slot",
      "--project",
      repoDir,
      "--json",
    ]);
    expect(created.error).toBeUndefined();
    expect(created.slot).toBe(1);

    const detected = cli([
      "detect",
      "2026-08-07-cli-slot",
      "--project",
      repoDir,
      "--json",
    ]);
    expect(detected.slot).toBe(1);
    // The convention has to travel with the value — JSON has no room for
    // prose, so it gets its own field rather than being lost.
    expect(String(detected.slotNote)).toContain("main checkout");
  }, 120_000);
});

describe("worktree CLI subcommand registration", () => {
  it("should execute detect, create, sync via CLI binary", async () => {
    // Test that the subcommands are registered by running help
    const result = Bun.spawnSync(
      ["bun", "run", "src/cli/index.ts", "worktree", "--help"],
      {
        cwd: resolve(import.meta.dir, "..", "..", ".."),
      },
    );
    const output = new TextDecoder().decode(result.stdout);

    // Verify new subcommands appear in help
    expect(output).toContain("detect");
    expect(output).toContain("create");
    expect(output).toContain("sync");
  });
});
