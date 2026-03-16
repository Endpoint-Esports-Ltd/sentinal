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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { registerWorktreeTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import type { DiffSummary } from "./types.js";
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
    const wtStore = new WorktreeStore(store);
    wtStore.insert({
      id: "wt-test-1",
      specId: "my-feature",
      projectPath: tmpDir,
      worktreePath: join(tmpDir, ".worktrees", "my-feature"),
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
    // Insert a worktree record
    createSpec(tmpDir, store, "diff-feature");
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
    const origSquashMerge = WorktreeManager.prototype.squashMerge;
    WorktreeManager.prototype.hasConflicts = function () {
      return false;
    };
    WorktreeManager.prototype.squashMerge = function () {
      return "deadbeef1234567890";
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
    } finally {
      WorktreeManager.prototype.hasConflicts = origHasConflicts;
      WorktreeManager.prototype.squashMerge = origSquashMerge;
    }
  });
});

// --- Sidecar mode tests ---

describe("worktree MCP tools (sidecar mode)", () => {
  it("worktree_detect should use client.resolveWorktreeBySlug", async () => {
    const mockClient = {
      resolveWorktreeBySlug: async (slug: string, project?: string) => ({
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
});
