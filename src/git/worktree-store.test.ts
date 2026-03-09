import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "./worktree-store.js";
import type { Worktree, WorktreeStatus } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sentinal-wts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a worktree record. specId defaults to null (no FK constraint). */
function makeWorktree(overrides: Partial<Worktree> = {}): Omit<Worktree, "mergedAt" | "mergeCommit"> {
  return {
    id: `wt-${Math.random().toString(36).slice(2)}`,
    specId: undefined,
    projectPath: "/test/project",
    worktreePath: "/test/project/.sentinal/worktrees/spec-test",
    branchName: "sentinal/spec-test",
    baseBranch: "main",
    baseCommit: "abc123def456",
    status: "active" as WorktreeStatus,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Create a spec in the DB so it can be referenced by FK. */
function createSpec(tmpDir: string, memoryStore: MemoryStore, specId: string): void {
  const plansDir = join(tmpDir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${specId}.md`);
  writeFileSync(planFile, `# Test Spec\n\nStatus: PENDING\nType: Feature\n`);
  const specStore = new SpecStore(memoryStore);
  specStore.syncFromPlanFile(planFile, "/test/project");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WorktreeStore", () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;
  let store: WorktreeStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    memoryStore = new MemoryStore(join(tmpDir, "test.db"));
    store = new WorktreeStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("insert + get", () => {
    it("should insert and retrieve a worktree", () => {
      const wt = makeWorktree({ id: "wt-1" });
      const result = store.insert(wt);

      expect(result.id).toBe("wt-1");
      expect(result.projectPath).toBe("/test/project");
      expect(result.branchName).toBe("sentinal/spec-test");
      expect(result.status).toBe("active");
      expect(result.mergedAt).toBeUndefined();
    });

    it("should return null for non-existent id", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("getBySpecId", () => {
    it("should return active worktree for spec", () => {
      createSpec(tmpDir, memoryStore, "spec-1");
      store.insert(makeWorktree({ id: "wt-a", specId: "spec-1" }));
      const result = store.getBySpecId("spec-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("wt-a");
    });

    it("should not return abandoned worktrees", () => {
      createSpec(tmpDir, memoryStore, "spec-2");
      store.insert(makeWorktree({ id: "wt-b", specId: "spec-2" }));
      store.updateStatus("wt-b", "abandoned");
      expect(store.getBySpecId("spec-2")).toBeNull();
    });

    it("should return null for non-existent spec", () => {
      expect(store.getBySpecId("nonexistent")).toBeNull();
    });
  });

  describe("listForProject", () => {
    it("should list all worktrees for a project", () => {
      store.insert(makeWorktree({ id: "wt-1", projectPath: "/project-a" }));
      store.insert(makeWorktree({ id: "wt-2", projectPath: "/project-a" }));
      store.insert(makeWorktree({ id: "wt-3", projectPath: "/project-b" }));

      const result = store.listForProject("/project-a");
      expect(result).toHaveLength(2);
    });

    it("should filter by status", () => {
      store.insert(makeWorktree({ id: "wt-1", projectPath: "/proj" }));
      store.insert(makeWorktree({ id: "wt-2", projectPath: "/proj" }));
      store.updateStatus("wt-2", "merged", "abc123");

      const active = store.listForProject("/proj", "active");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("wt-1");
    });
  });

  describe("listAll", () => {
    it("should list all worktrees", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      store.insert(makeWorktree({ id: "wt-2" }));
      expect(store.listAll()).toHaveLength(2);
    });

    it("should filter by status", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      store.insert(makeWorktree({ id: "wt-2" }));
      store.updateStatus("wt-1", "abandoned");

      expect(store.listAll("active")).toHaveLength(1);
      expect(store.listAll("abandoned")).toHaveLength(1);
    });
  });

  describe("updateStatus", () => {
    it("should update status", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      store.updateStatus("wt-1", "ready-to-merge");

      const wt = store.get("wt-1");
      expect(wt!.status).toBe("ready-to-merge");
    });

    it("should set merge info when status is merged", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      store.updateStatus("wt-1", "merged", "commit-hash-123");

      const wt = store.get("wt-1");
      expect(wt!.status).toBe("merged");
      expect(wt!.mergeCommit).toBe("commit-hash-123");
      expect(wt!.mergedAt).toBeGreaterThan(0);
    });
  });

  describe("delete", () => {
    it("should delete a worktree and return true", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      expect(store.delete("wt-1")).toBe(true);
      expect(store.get("wt-1")).toBeNull();
    });

    it("should return false for non-existent id", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("countActive", () => {
    it("should count only active worktrees", () => {
      store.insert(makeWorktree({ id: "wt-1" }));
      store.insert(makeWorktree({ id: "wt-2" }));
      store.insert(makeWorktree({ id: "wt-3" }));
      store.updateStatus("wt-3", "abandoned");

      expect(store.countActive()).toBe(2);
    });

    it("should filter by project", () => {
      store.insert(makeWorktree({ id: "wt-1", projectPath: "/proj-a" }));
      store.insert(makeWorktree({ id: "wt-2", projectPath: "/proj-b" }));

      expect(store.countActive("/proj-a")).toBe(1);
      expect(store.countActive("/proj-b")).toBe(1);
    });

    it("should return 0 when no active worktrees", () => {
      expect(store.countActive()).toBe(0);
    });
  });
});
