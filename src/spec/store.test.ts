import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";

// --- Helpers ---

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sentinal-spec-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlan(dir: string, filename: string, content: string): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const filePath = join(plansDir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

// --- Tests ---

describe("SpecStore", () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;
  let specStore: SpecStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    memoryStore = new MemoryStore(join(tmpDir, "test.db"));
    specStore = new SpecStore(memoryStore);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("syncFromPlanFile", () => {
    it("should sync a plan file and return the spec", () => {
      const planFile = writePlan(tmpDir, "2026-03-09-feature.md", `# Feature Plan

Status: PENDING
Type: Feature

## Progress Tracking

- [ ] Task 1: Setup
- [ ] Task 2: Build
`);

      const spec = specStore.syncFromPlanFile(planFile, "/test/project");
      expect(spec.id).toBe("2026-03-09-feature");
      expect(spec.title).toBe("Feature Plan");
      expect(spec.status).toBe("PENDING");
      expect(spec.tasks).toHaveLength(2);
    });

    it("should be retrievable after sync", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-test.md", `# Test Plan

Status: IN PROGRESS
Type: Feature
`);

      specStore.syncFromPlanFile(planFile, "/test/project");
      const spec = specStore.getSpec("2026-01-01-test");
      expect(spec).not.toBeNull();
      expect(spec!.title).toBe("Test Plan");
      expect(spec!.status).toBe("IN_PROGRESS");
    });

    it("should update existing spec on re-sync", () => {
      const planPath = join(tmpDir, "docs", "plans", "2026-01-01-test.md");
      mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });

      writeFileSync(planPath, "# Test\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planPath, "/test/project");

      writeFileSync(planPath, "# Test Updated\n\nStatus: COMPLETE\n");
      specStore.syncFromPlanFile(planPath, "/test/project");

      const spec = specStore.getSpec("2026-01-01-test");
      expect(spec!.title).toBe("Test Updated");
      expect(spec!.status).toBe("COMPLETE");
    });
  });

  describe("syncAllPlans", () => {
    it("should sync all plan files from a directory", () => {
      writePlan(tmpDir, "2026-01-01-alpha.md", "# Alpha\n\nStatus: VERIFIED\n");
      writePlan(tmpDir, "2026-02-01-beta.md", "# Beta\n\nStatus: PENDING\n");
      writePlan(tmpDir, "2026-03-01-gamma.md", "# Gamma\n\nStatus: IN PROGRESS\n");

      const count = specStore.syncAllPlans(join(tmpDir, "docs", "plans"), "/test/project");
      expect(count).toBe(3);

      const specs = specStore.listSpecs("/test/project");
      expect(specs).toHaveLength(3);
    });

    it("should return 0 for non-existent directory", () => {
      const count = specStore.syncAllPlans("/nonexistent/path", "/test/project");
      expect(count).toBe(0);
    });
  });

  describe("getCurrentSpec", () => {
    it("should return the most recent active spec", () => {
      writePlan(tmpDir, "2026-01-01-old.md", "# Old\n\nStatus: VERIFIED\n");
      const activePath = writePlan(tmpDir, "2026-02-01-active.md", "# Active\n\nStatus: PENDING\n");

      specStore.syncAllPlans(join(tmpDir, "docs", "plans"), "/test/project");
      const current = specStore.getCurrentSpec("/test/project");
      expect(current).not.toBeNull();
      expect(current!.id).toBe("2026-02-01-active");
    });

    it("should return null when no active specs", () => {
      writePlan(tmpDir, "2026-01-01-done.md", "# Done\n\nStatus: VERIFIED\n");
      specStore.syncAllPlans(join(tmpDir, "docs", "plans"), "/test/project");

      const current = specStore.getCurrentSpec("/test/project");
      expect(current).toBeNull();
    });

    it("should not return specs from other projects", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-test.md", "# Test\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planFile, "/other/project");

      const current = specStore.getCurrentSpec("/test/project");
      expect(current).toBeNull();
    });
  });

  describe("task persistence", () => {
    it("should persist and retrieve tasks", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-tasks.md", `# Tasks Plan

Status: IN PROGRESS
Type: Feature

## Progress Tracking

- [x] Task 1: Setup complete
- [~] Task 2: In progress work
- [ ] Task 3: Not started
`);

      specStore.syncFromPlanFile(planFile, "/test/project");
      const spec = specStore.getSpec("2026-01-01-tasks");

      expect(spec!.tasks).toHaveLength(3);
      expect(spec!.tasks[0].status).toBe("complete");
      expect(spec!.tasks[1].status).toBe("in-progress");
      expect(spec!.tasks[2].status).toBe("pending");
    });
  });

  describe("session_id persistence", () => {
    it("should persist session_id when provided", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-session.md", "# Session Test\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planFile, "/test/project", "sess-abc-123");

      const spec = specStore.getSpec("2026-01-01-session");
      expect(spec).not.toBeNull();
      expect(spec!.sessionId).toBe("sess-abc-123");
    });

    it("should have null session_id when not provided", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-nosess.md", "# No Session\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planFile, "/test/project");

      const spec = specStore.getSpec("2026-01-01-nosess");
      expect(spec).not.toBeNull();
      expect(spec!.sessionId).toBeUndefined();
    });
  });

  describe("metadata persistence", () => {
    it("should round-trip worktree metadata", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-wt.md", `# Worktree Plan

Status: PENDING
Type: Feature
Worktree: Yes
Iterations: 3
`);

      specStore.syncFromPlanFile(planFile, "/test/project");
      const spec = specStore.getSpec("2026-01-01-wt");

      expect(spec).not.toBeNull();
      expect(spec!.metadata.worktree).toBe(true);
      expect(spec!.metadata.iterations).toBe(3);
    });

    it("should handle plans without metadata", () => {
      const planFile = writePlan(tmpDir, "2026-01-01-plain.md", "# Plain\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planFile, "/test/project");

      const spec = specStore.getSpec("2026-01-01-plain");
      expect(spec).not.toBeNull();
      expect(spec!.metadata).toEqual({});
    });

    it("should update metadata on re-sync", () => {
      const planPath = join(tmpDir, "docs", "plans", "2026-01-01-meta.md");
      mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });

      writeFileSync(planPath, "# Meta\n\nStatus: PENDING\n");
      specStore.syncFromPlanFile(planPath, "/test/project");
      expect(specStore.getSpec("2026-01-01-meta")!.metadata.worktree).toBeUndefined();

      writeFileSync(planPath, "# Meta\n\nStatus: IN PROGRESS\nWorktree: Yes\n");
      specStore.syncFromPlanFile(planPath, "/test/project");
      expect(specStore.getSpec("2026-01-01-meta")!.metadata.worktree).toBe(true);
    });
  });

  describe("V5 migration — worktrees table", () => {
    it("should have worktrees table available", () => {
      const db = memoryStore.getRawDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktrees'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("should have worktree indexes", () => {
      const db = memoryStore.getRawDb();
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_wt_%'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_wt_project");
      expect(names).toContain("idx_wt_status");
      expect(names).toContain("idx_wt_spec");
    });
  });
});
