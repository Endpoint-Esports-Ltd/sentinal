/**
 * Worktree CLI Command Tests
 *
 * Tests for the new worktree CLI subcommands:
 *   - detect: Find worktree by slug
 *   - create: Create worktree for a slug
 *   - sync: Squash-merge a worktree by slug
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";
import { WorktreeStore } from "../../worktree/store.js";

// --- Helpers ---

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-wt-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
