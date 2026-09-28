/**
 * Worktree MCP Tools Tests
 *
 * Tests for worktree MCP tools:
 *   - worktree_detect: Find worktree by plan slug
 *   - worktree_create: Create worktree for a plan slug
 *   - worktree_diff: Get diff summary for a worktree
 *   - worktree_sync: Squash-merge a worktree
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { registerWorktreeTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import { DEFAULT_WORKTREE_CONFIG, type DiffSummary } from "./types.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";

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

// --- worktree_detect tests ---

describe("worktree_detect MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_detect")).toBe(true);
  });

  it("should return 'not found' when no worktree exists", async () => {
    const handler = tools.get("worktree_detect")!;
    const result = await handler({ plan_slug: "nonexistent-plan" });

    expect(result.content[0].text).toContain("No active worktree");
    expect(result.content[0].text).toContain("nonexistent-plan");
  });

  it("should find an existing worktree by slug", async () => {
    // Create a spec and worktree
    createSpec(tmpDir, store, "my-feature");
    const wtPath = join(tmpDir, ".worktrees", "my-feature");
    mkdirSync(wtPath, { recursive: true }); // directory must exist for self-healing check
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-test-1",
      specId: "my-feature",
      projectPath: tmpDir,
      worktreePath: wtPath,
      branchName: "spec/my-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const handler = tools.get("worktree_detect")!;
    const result = await handler({ plan_slug: "my-feature", project: tmpDir });

    expect(result.content[0].text).toContain("spec/my-feature");
    expect(result.content[0].text).toContain("active");
  });

  it("should reconcile against disk when the index lost the record (direct mode)", async () => {
    // Real git repo with an on-disk worktree whose DB record was lost
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });

    const wtStore = new WorktreeStore(store);
    const manager = new WorktreeManager(wtStore);
    const wt = manager.create("2026-06-09-tool-drift", repoDir);
    wtStore.delete(wt.id);

    const handler = tools.get("worktree_detect")!;
    const result = await handler({
      plan_slug: "2026-06-09-tool-drift",
      project: repoDir,
    });

    expect(result.content[0].text).toContain(wt.branchName);
    expect(result.content[0].text).toContain("active");
    expect(result.content[0].text).not.toContain("No active worktree");
  });
});

// --- worktree_create tests ---

describe("worktree_create MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_create")).toBe(true);
  });

  it("registers worktree_ensure alongside it (orca Task 9)", () => {
    expect(tools.has("worktree_ensure")).toBe(true);
  });

  // Note: actual worktree creation requires a git repo, so we test error handling
  it("should return error when not in a git repo", async () => {
    const handler = tools.get("worktree_create")!;
    const result = await handler({ plan_slug: "my-feature", project: tmpDir });

    // Should gracefully handle the error (not in a git repo)
    expect(result.content[0].text).toContain("Error");
  });

  it("should return worktree info on successful creation", async () => {
    const origCreate = WorktreeManager.prototype.create;
    WorktreeManager.prototype.create = function (
      _specId: string | undefined,
      _projectPath: string,
    ) {
      return {
        id: "wt-mock-1",
        specId: "test-feature",
        projectPath: tmpDir,
        worktreePath: join(tmpDir, ".worktrees", "test-feature"),
        branchName: "spec/test-feature",
        baseBranch: "main",
        baseCommit: "abc123",
        status: "active" as const,
        createdAt: Date.now(),
      };
    };

    try {
      // Re-capture tools with mocked manager
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_create")!;
      const result = await handler({
        plan_slug: "test-feature",
        project: tmpDir,
      });

      expect(result.content[0].text).toContain("Created Worktree");
      expect(result.content[0].text).toContain("spec/test-feature");
      expect(result.content[0].text).toContain("main");
    } finally {
      WorktreeManager.prototype.create = origCreate;
    }
  });
});

// --- worktree_diff tests ---

describe("worktree_diff MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_diff")).toBe(true);
  });

  it("should return not found when no worktree matches", async () => {
    const handler = tools.get("worktree_diff")!;
    const result = await handler({ plan_slug: "nonexistent" });

    expect(result.content[0].text).toContain("No active worktree");
  });

  it("should return formatted diff when worktree exists", async () => {
    // Insert a worktree record (directory must exist — resolution is disk-authoritative)
    createSpec(tmpDir, store, "diff-feature");
    mkdirSync(join(tmpDir, ".worktrees", "diff-feature"), { recursive: true });
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-diff-1",
      specId: "diff-feature",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "diff-feature"),
      branchName: "spec/diff-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const mockDiff: DiffSummary = {
      filesChanged: 3,
      insertions: 42,
      deletions: 10,
      files: [
        {
          path: "src/foo.ts",
          status: "modified",
          insertions: 30,
          deletions: 5,
        },
        { path: "src/bar.ts", status: "added", insertions: 12, deletions: 0 },
        { path: "src/old.ts", status: "deleted", insertions: 0, deletions: 5 },
      ],
    };

    const origDiff = WorktreeManager.prototype.diff;
    WorktreeManager.prototype.diff = function () {
      return mockDiff;
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_diff")!;
      const result = await handler({
        plan_slug: "diff-feature",
        project: tmpDir,
      });

      const text = result.content[0].text;
      expect(text).toContain("Files Changed:** 3");
      expect(text).toContain("Insertions:** +42");
      expect(text).toContain("Deletions:** -10");
      expect(text).toContain("modified src/foo.ts (+30/-5)");
      expect(text).toContain("added src/bar.ts (+12/-0)");
      expect(text).toContain("deleted src/old.ts (+0/-5)");
    } finally {
      WorktreeManager.prototype.diff = origDiff;
    }
  });
});

// --- worktree_sync tests ---

describe("worktree_sync MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_sync")).toBe(true);
  });

  it("should return not found when no worktree matches", async () => {
    const handler = tools.get("worktree_sync")!;
    const result = await handler({ plan_slug: "nonexistent" });

    expect(result.content[0].text).toContain("No active worktree");
  });

  it("should return error when worktree has conflicts", async () => {
    createSpec(tmpDir, store, "conflict-feature");
    mkdirSync(join(tmpDir, ".worktrees", "conflict-feature"), {
      recursive: true,
    });
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-conflict-1",
      specId: "conflict-feature",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "conflict-feature"),
      branchName: "spec/conflict-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const origHasConflicts = WorktreeManager.prototype.hasConflicts;
    WorktreeManager.prototype.hasConflicts = function () {
      return true;
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_sync")!;
      const result = await handler({
        plan_slug: "conflict-feature",
        project: tmpDir,
      });

      expect(result.content[0].text).toContain("merge conflicts");
    } finally {
      WorktreeManager.prototype.hasConflicts = origHasConflicts;
    }
  });

  it("should return commit hash on successful merge", async () => {
    createSpec(tmpDir, store, "merge-feature");
    mkdirSync(join(tmpDir, ".worktrees", "merge-feature"), { recursive: true });
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-merge-1",
      specId: "merge-feature",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "merge-feature"),
      branchName: "spec/merge-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const origHasConflicts = WorktreeManager.prototype.hasConflicts;
    const origSquashMerge = WorktreeManager.prototype.squashMergeDetailed;
    WorktreeManager.prototype.hasConflicts = function () {
      return false;
    };
    WorktreeManager.prototype.squashMergeDetailed = async function () {
      return {
        commit: "deadbeef1234567890",
        mergedIn: tmpDir,
        outcome: "removed" as const,
      };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_sync")!;
      const result = await handler({
        plan_slug: "merge-feature",
        project: tmpDir,
      });

      const text = result.content[0].text;
      expect(text).toContain("Merged:");
      expect(text).toContain("deadbeef1234567890");
      expect(text).toContain("spec/merge-feature");
      expect(text).toContain("main");
      expect(text).toContain(`**Merged in:** ${tmpDir}`);
      expect(text).toContain("**Worktree:** removed");
    } finally {
      WorktreeManager.prototype.hasConflicts = origHasConflicts;
      WorktreeManager.prototype.squashMergeDetailed = origSquashMerge;
    }
  });

  it("reports where the commit landed, an external release, and warnings (orca D3/D2)", async () => {
    createSpec(tmpDir, store, "ext-merge");
    mkdirSync(join(tmpDir, ".worktrees", "ext-merge"), { recursive: true });
    new WorktreeStore(store).insert({
      id: "wt-ext-merge",
      specId: "ext-merge",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "ext-merge"),
      branchName: "spec/ext-merge",
      baseBranch: "coord",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const origHasConflicts = WorktreeManager.prototype.hasConflicts;
    const origDetailed = WorktreeManager.prototype.squashMergeDetailed;
    WorktreeManager.prototype.hasConflicts = () => false;
    WorktreeManager.prototype.squashMergeDetailed = async function (
      _id: string,
      _message?: string,
      warnings?: string[],
    ) {
      warnings?.push("restored the holder's branch");
      return {
        commit: "cafe1234",
        mergedIn: "/coordinator/checkout",
        outcome: "released" as const,
      };
    };
    try {
      const mocked = captureTools(registerWorktreeTools, store);
      const result = await mocked.get("worktree_sync")!({
        plan_slug: "ext-merge",
        project: tmpDir,
      });
      const text = result.content[0].text;
      expect(text).toContain(
        "Merged: cafe1234 (branch: spec/ext-merge → coord)",
      );
      expect(text).toContain("**Merged in:** /coordinator/checkout");
      expect(text).toContain("**Worktree:** released");
      expect(text).toContain("### Warnings");
      expect(text).toContain("restored the holder's branch");
    } finally {
      WorktreeManager.prototype.hasConflicts = origHasConflicts;
      WorktreeManager.prototype.squashMergeDetailed = origDetailed;
    }
  });
});

// --- Sidecar mode tests ---

describe("worktree MCP tools (sidecar mode)", () => {
  it("worktree_detect should use client.resolveWorktreeBySlug", async () => {
    const mockClient = {
      resolveWorktreeBySlug: async (_slug: string, _project?: string) => ({
        id: "wt-1",
        worktreePath: "/tmp/wt",
        branchName: "spec/my-slug",
        baseBranch: "main",
        status: "active",
      }),
    } as unknown as SidecarClient;

    const tools = captureTools(registerWorktreeTools, {
      client: mockClient,
    });

    const handler = tools.get("worktree_detect")!;
    const result = await handler({ plan_slug: "my-slug", project: "/test" });
    expect(result.content[0].text).toContain("spec/my-slug");
    expect(result.content[0].text).toContain("active");
  });

  it("worktree_detect SURFACES the warnings the sidecar computed", async () => {
    // ⛔ Sidecar mode is the default production path. Warnings that reach the
    // route but not the model make "warn loudly" a no-op where it matters most.
    const mockClient = {
      resolveWorktreeBySlug: async () => ({
        id: "wt-warn",
        worktreePath: "/tmp/wt",
        branchName: "spec/warned-slug",
        baseBranch: "main",
        status: "active",
        slot: null,
        warnings: ["No .env.example found — nothing was seeded"],
      }),
    } as unknown as SidecarClient;

    const tools = captureTools(registerWorktreeTools, { client: mockClient });
    const result = await tools.get("worktree_detect")!({
      plan_slug: "warned-slug",
      project: "/test",
    });

    const text = result.content[0].text;
    expect(text).toContain("### Warnings");
    expect(text).toContain("No .env.example found");
  });
});

// --- worktree_detect self-healing tests ---

describe("worktree_detect — stale worktree self-healing", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let wtStore: WorktreeStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    wtStore = new WorktreeStore(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return 'not found' when worktree directory no longer exists on disk", async () => {
    // Insert a worktree pointing to a path that doesn't exist on disk
    createSpec(tmpDir, store, "stale-feature");
    wtStore.insert({
      id: "wt-stale-1",
      specId: "stale-feature",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "stale-feature"), // does not exist
      branchName: "spec/stale-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const tools = captureTools(registerWorktreeTools, store);
    const handler = tools.get("worktree_detect")!;
    const result = await handler({
      plan_slug: "stale-feature",
      project: tmpDir,
    });

    // Should report not found, not the stale entry
    expect(result.content[0].text).toContain("No active worktree");
  });

  it("should auto-mark stale worktree as abandoned when directory is missing", async () => {
    createSpec(tmpDir, store, "stale-auto");
    wtStore.insert({
      id: "wt-stale-auto-1",
      specId: "stale-auto",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "stale-auto"), // does not exist
      branchName: "spec/stale-auto",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const tools = captureTools(registerWorktreeTools, store);
    const handler = tools.get("worktree_detect")!;
    await handler({ plan_slug: "stale-auto", project: tmpDir });

    // The row should now be abandoned in SQLite
    const updated = wtStore.get("wt-stale-auto-1");
    expect(updated?.status).toBe("abandoned");
  });

  it("should still find a worktree when its directory DOES exist", async () => {
    createSpec(tmpDir, store, "live-feature");
    const wtPath = join(tmpDir, ".worktrees", "live-feature");
    mkdirSync(wtPath, { recursive: true }); // directory exists
    wtStore.insert({
      id: "wt-live-1",
      specId: "live-feature",
      projectPath: tmpDir,
      worktreePath: wtPath,
      branchName: "spec/live-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    const tools = captureTools(registerWorktreeTools, store);
    const handler = tools.get("worktree_detect")!;
    const result = await handler({
      plan_slug: "live-feature",
      project: tmpDir,
    });

    expect(result.content[0].text).toContain("spec/live-feature");
    expect(result.content[0].text).toContain("active");
  });
});

// --- worktree_abandon tests ---

describe("worktree_abandon MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let wtStore: WorktreeStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    wtStore = new WorktreeStore(store);
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_abandon")).toBe(true);
  });

  it("should return error when no worktree found for slug", async () => {
    const handler = tools.get("worktree_abandon")!;
    const result = await handler({
      plan_slug: "nonexistent-plan",
      project: tmpDir,
    });

    expect(result.content[0].text).toContain("No active worktree");
  });

  it("should abandon a worktree and mark it as abandoned in SQLite", async () => {
    createSpec(tmpDir, store, "abandon-feature");
    const wtPath = join(tmpDir, ".worktrees", "abandon-feature");
    mkdirSync(wtPath, { recursive: true });
    wtStore.insert({
      id: "wt-abandon-1",
      specId: "abandon-feature",
      projectPath: tmpDir,
      worktreePath: wtPath,
      branchName: "spec/abandon-feature",
      baseBranch: "main",
      baseCommit: "abc123",
      status: "active",
      createdAt: Date.now(),
    });

    // Mock manager.abandon to avoid git operations
    const origAbandon = WorktreeManager.prototype.abandon;
    WorktreeManager.prototype.abandon = async function (worktreeId: string) {
      // Just update status to abandoned in store (skip git ops)
      (this as unknown as { store: WorktreeStore }).store.updateStatus(
        worktreeId,
        "abandoned",
      );
      return { outcome: "removed" as const, message: "", warnings: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_abandon")!;
      const result = await handler({
        plan_slug: "abandon-feature",
        project: tmpDir,
      });

      expect(result.content[0].text).toContain("abandoned");

      // Verify SQLite row is now abandoned
      const updated = wtStore.get("wt-abandon-1");
      expect(updated?.status).toBe("abandoned");
    } finally {
      WorktreeManager.prototype.abandon = origAbandon;
    }
  });

  it("D2: an EXTERNAL worktree found by its slug is released — dir, branch and work survive", async () => {
    const root = realpathSync(tmpDir);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], cwd = repo) =>
      Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@t.com"]);
    git(["config", "user.name", "T"]);
    writeFileSync(join(repo, "README.md"), "# t\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    git([
      "worktree",
      "add",
      "-b",
      "feature-x",
      join(root, "orca", "feature-x"),
    ]);
    const ext = realpathSync(join(root, "orca", "feature-x"));
    writeFileSync(join(ext, "work.txt"), "uncommitted\n");
    wtStore.insert({
      id: "wt-ext-tool",
      specId: null,
      projectPath: repo,
      worktreePath: ext,
      branchName: "feature-x",
      baseBranch: "main",
      baseCommit: "HEAD",
      status: "active",
      slot: null,
      owner: "external",
      slug: "orca-feature",
      createdAt: Date.now(),
    });

    const result = await tools.get("worktree_abandon")!({
      plan_slug: "orca-feature",
      project: repo,
    });

    expect(result.content[0].text).not.toMatch(/^Error/);
    // Carry-over from Task 5: the result says it was RELEASED, not removed.
    expect(result.content[0].text).toContain("**Outcome:** released");
    expect(existsSync(join(ext, "work.txt"))).toBe(true);
    expect(
      git(["rev-parse", "--verify", "--quiet", "refs/heads/feature-x"])
        .exitCode,
    ).toBe(0);
    expect(wtStore.get("wt-ext-tool")!.status).toBe("abandoned");
  }, 20_000);
});

// --- worktree_cleanup tests ---

describe("worktree_cleanup MCP tool", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    new WorktreeStore(store);
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be registered as a tool", () => {
    expect(tools.has("worktree_cleanup")).toBe(true);
  });

  it("should return count of 0 when no stale worktrees exist", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return { cleaned: 0, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_cleanup")!;
      const result = await handler({ project: tmpDir });

      expect(result.content[0].text).toContain("0");
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("should return count of cleaned worktrees", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return { cleaned: 3, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_cleanup")!;
      const result = await handler({ project: tmpDir });

      expect(result.content[0].text).toContain("3");
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  // ── Idempotency on abandon (issue #9) ───────────────────────────────────
  // Abandon removes a directory AND stops a process group, so a
  // double-execute after an ambiguous transport failure is not harmless the
  // way a double-cleanup is.
  it("forwards idempotency_key to the sidecar on abandon", async () => {
    let received: unknown = "NOT_CALLED";
    const fakeClient = {
      resolveWorktreeBySlug: async () => ({
        id: "wt-1",
        branchName: "sentinal/spec-x",
        worktreePath: "/w/x",
      }),
      abandonWorktree: async (_id: string, opts?: unknown) => {
        received = opts;
      },
    };
    const clientTools = captureTools(registerWorktreeTools, {
      client: fakeClient as any,
      store,
    });
    const handler = clientTools.get("worktree_abandon")!;
    await handler({ plan_slug: "x", idempotency_key: "abandon-key-1" });

    expect((received as { idempotencyKey?: string }).idempotencyKey).toBe(
      "abandon-key-1",
    );
  });

  it("surfaces the sidecar's abandon message, outcome and warnings", async () => {
    const fakeClient = {
      resolveWorktreeBySlug: async () => ({
        id: "wt-ext",
        branchName: "orca-x",
        worktreePath: "/w/orca-x",
      }),
      abandonWorktree: async () => ({
        worktree_id: "wt-ext",
        status: "abandoned",
        outcome: "released",
        message: "Released /w/orca-x — left in place (owner external).",
        warnings: ["kept .env: modified since seeding"],
      }),
    };
    const clientTools = captureTools(registerWorktreeTools, {
      client: fakeClient as any,
      store,
    });
    const result = await clientTools.get("worktree_abandon")!({
      plan_slug: "x",
    });
    const text = result.content[0].text as string;
    expect(text).toContain("Worktree abandoned: orca-x");
    expect(text).toContain("**Outcome:** released");
    expect(text).toContain("Released /w/orca-x — left in place");
    expect(text).toContain("kept .env: modified since seeding");
  });

  it("an OLD sidecar (no payload) still yields the classic line", async () => {
    const fakeClient = {
      resolveWorktreeBySlug: async () => ({
        id: "wt-1",
        branchName: "sentinal/spec-x",
        worktreePath: "/w/x",
      }),
      abandonWorktree: async () => undefined,
    };
    const clientTools = captureTools(registerWorktreeTools, {
      client: fakeClient as any,
      store,
    });
    const result = await clientTools.get("worktree_abandon")!({
      plan_slug: "x",
    });
    const text = result.content[0].text as string;
    expect(text).toBe("Worktree abandoned: sentinal/spec-x (was at /w/x)");
  });

  // ── The acted-on set (issue #9) ─────────────────────────────────────────
  // A destructive cleanup that reported failure had in fact removed 7
  // worktrees. `Cleaned up 7 stale worktrees.` would have made the success
  // obvious; a bare count paired with an error message did not. The tool must
  // name what it removed.
  it("names the worktrees it removed, not just how many", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return {
        cleaned: 2,
        removed: [
          {
            path: "/repo/.sentinal/worktrees/spec-alpha",
            branch: "sentinal/spec-alpha",
            slug: "alpha",
            pass: "force" as const,
          },
          {
            path: "/repo/.sentinal/worktrees/spec-beta",
            branch: "sentinal/spec-beta",
            slug: "beta",
            pass: "missing-dir" as const,
          },
        ],
      };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_cleanup")!;
      const result = await handler({ project: tmpDir, force: true });
      const text = result.content[0].text as string;

      expect(text).toContain("2");
      expect(text).toContain("/repo/.sentinal/worktrees/spec-alpha");
      expect(text).toContain("sentinal/spec-alpha");
      expect(text).toContain("/repo/.sentinal/worktrees/spec-beta");
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("states plainly that nothing remained when a retry is a no-op", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function () {
      return { cleaned: 0, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_cleanup")!;
      const result = await handler({ project: tmpDir, force: true });
      const text = result.content[0].text as string;

      // "Cleaned up 0 stale worktrees." alone reads as "there was nothing to
      // do" — which is exactly the reading that drives an agent to rm -rf.
      expect(text).toMatch(/nothing (was )?remain|already|no worktrees/i);
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("passes force + project + an isPlanActive guard to cleanup() on the direct path", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    let received: unknown = "NOT_CALLED";
    WorktreeManager.prototype.cleanup = function (opts?: unknown) {
      received = opts;
      return { cleaned: 1, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const handler = mockedTools.get("worktree_cleanup")!;
      await handler({ project: tmpDir, force: true });

      const opts = received as {
        force?: boolean;
        projectPath?: string;
        isPlanActive?: (slug: string) => boolean;
      };
      expect(opts.force).toBe(true);
      expect(opts.projectPath).toBe(tmpDir);
      expect(typeof opts.isPlanActive).toBe("function");
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  // ── Guard 3's dead input (pre-existing defect, fixed in Task 5) ───────────
  //
  // ⛔ Neither path threaded `currentWorktree`, so guard 3 ("never the caller's
  // current worktree") had NO effect in production: `worktree_cleanup --force`
  // could delete the very directory the caller was working in. `client.ts`
  // already forwarded the field (`:531-540`) and the sidecar route already read
  // it from the body — the gap was purely caller-side.

  it("threads currentWorktree on the DIRECT path, so guard 3 is live", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    let received: { currentWorktree?: string } = {};
    WorktreeManager.prototype.cleanup = function (opts?: unknown) {
      received = opts as { currentWorktree?: string };
      return { cleaned: 0, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      await mockedTools.get("worktree_cleanup")!({
        project: tmpDir,
        force: true,
        current_worktree: "/caller/project/.sentinal/worktrees/spec-live",
      });
      expect(received.currentWorktree).toBe(
        "/caller/project/.sentinal/worktrees/spec-live",
      );
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("defaults currentWorktree to the TOOL PROCESS's cwd, never the sidecar's", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    let received: { currentWorktree?: string } = {};
    WorktreeManager.prototype.cleanup = function (opts?: unknown) {
      received = opts as { currentWorktree?: string };
      return { cleaned: 0, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      await mockedTools.get("worktree_cleanup")!({
        project: tmpDir,
        force: true,
      });
      // This process IS the caller's — the MCP server is spawned in the agent's
      // working directory. The sidecar is a different, long-lived process, which
      // is why the same default would be wrong there.
      expect(received.currentWorktree).toBe(process.cwd());
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("threads currentWorktree on the SIDECAR path too", async () => {
    const calls: { project?: string; opts?: unknown }[] = [];
    const fakeClient = {
      cleanupWorktrees: async (project?: string, opts?: unknown) => {
        calls.push({ project, opts });
        return { cleaned: 0 };
      },
    } as unknown as SidecarClient;

    const clientTools = captureTools(registerWorktreeTools, {
      store,
      client: fakeClient,
    });
    await clientTools.get("worktree_cleanup")!({
      project: tmpDir,
      force: true,
      current_worktree: "/caller/wt",
    });

    expect(calls).toHaveLength(1);
    expect(
      (calls[0]!.opts as { currentWorktree?: string }).currentWorktree,
    ).toBe("/caller/wt");
  });

  it("surfaces guard-5 warnings — a skipped cleanup must never be silent", async () => {
    const origCleanup = WorktreeManager.prototype.cleanup;
    WorktreeManager.prototype.cleanup = function (opts?: unknown) {
      (opts as { warnings?: string[] }).warnings?.push(
        "Skipped /wt/spec-x: pid 4242 is running from it.",
      );
      return { cleaned: 0, removed: [] };
    };

    try {
      const mockedTools = captureTools(registerWorktreeTools, store);
      const r = await mockedTools.get("worktree_cleanup")!({
        project: tmpDir,
        force: true,
      });
      expect(r.content[0].text).toContain("4242");
    } finally {
      WorktreeManager.prototype.cleanup = origCleanup;
    }
  });

  it("surfaces the sidecar's guard-5 warnings as well", async () => {
    const fakeClient = {
      cleanupWorktrees: async () => ({
        cleaned: 0,
        warnings: ["Skipped /wt/spec-y: pid 7777 is running from it."],
      }),
    } as unknown as SidecarClient;

    const clientTools = captureTools(registerWorktreeTools, {
      store,
      client: fakeClient,
    });
    const r = await clientTools.get("worktree_cleanup")!({
      project: tmpDir,
      force: true,
    });
    expect(r.content[0].text).toContain("7777");
  });
});

// --- Task 6: slot surfacing (D1 / D7) ---

describe("slot surfacing in MCP tool output", () => {
  let tmpDir: string;
  let repoDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });

    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerWorktreeTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("worktree_create reports the slot and the slot-0 convention", async () => {
    const result = await tools.get("worktree_create")!({
      plan_slug: "2026-08-07-surface-create",
      project: repoDir,
    });

    const text = result.content[0].text;
    expect(text).toContain("**Slot:** 1");
    // Without the convention the reader cannot know 0 is taken by their own stack.
    expect(text).toContain("slot 0 is the main checkout");
  });

  it("worktree_detect reports the slot and the slot-0 convention", async () => {
    const wtStore = new WorktreeStore(store);
    new WorktreeManager(wtStore).create("2026-08-07-surface-detect", repoDir);

    const result = await tools.get("worktree_detect")!({
      plan_slug: "2026-08-07-surface-detect",
      project: repoDir,
    });

    const text = result.content[0].text;
    expect(text).toContain("**Slot:** 1");
    expect(text).toContain("slot 0 is the main checkout");
  });

  it("⛔ renders an unassigned slot as prose, never the token `null`", async () => {
    const origCreate = WorktreeManager.prototype.create;
    WorktreeManager.prototype.create = function () {
      return {
        id: "wt-mock-null-slot",
        specId: undefined,
        projectPath: repoDir,
        worktreePath: join(repoDir, "wt"),
        branchName: "spec/x",
        baseBranch: "main",
        baseCommit: "abc123",
        status: "active" as const,
        slot: null,
        createdAt: Date.now(),
      };
    };

    try {
      const mocked = captureTools(registerWorktreeTools, store);
      const result = await mocked.get("worktree_create")!({
        plan_slug: "x",
        project: repoDir,
      });

      const text = result.content[0].text;
      expect(text).toContain(
        "not assigned (pre-V12 record, or no free slot — see warnings)",
      );
      expect(text).not.toContain("**Slot:** null");
    } finally {
      WorktreeManager.prototype.create = origCreate;
    }
  });

  it("worktree_create surfaces seeding warnings so an unseeded worktree is never silent", async () => {
    // No .env.example in this repo — the agent must be told, or it will fall
    // back to copying the repo-root .env (the issue #2 failure mode).
    const result = await tools.get("worktree_create")!({
      plan_slug: "2026-08-07-surface-warn",
      project: repoDir,
    });

    expect(result.content[0].text).toContain(".env.example");
  });

  it("worktree_create runs the injected setup and reports it (orca D5)", async () => {
    const calls: string[] = [];
    const withSetup = captureTools(registerWorktreeTools, {
      store,
      worktreeConfig: {
        ...DEFAULT_WORKTREE_CONFIG,
        runSetup: async (path: string) => {
          calls.push(path);
          return {
            ran: true,
            ok: true,
            exitCode: 0,
            timedOut: false,
            tail: "",
          };
        },
      },
    });
    const result = await withSetup.get("worktree_create")!({
      plan_slug: "2026-09-28-create-setup",
      project: repoDir,
    });
    const text = result.content[0].text;
    expect(calls.length).toBe(1);
    expect(text).toContain(`**Path:** ${calls[0]}`);
    expect(text).toContain("**Setup:** ran, ok");
  });
});
