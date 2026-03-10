import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";
import type { AuditResult } from "./store.js";

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

  describe("getCurrentTask", () => {
    it("returns null when spec has no tasks", () => {
      const planFile = writePlan(tmpDir, "empty-tasks.md", `# Empty
Status: IN PROGRESS
Type: Feature
`);
      specStore.syncFromPlanFile(planFile, tmpDir);
      expect(specStore.getCurrentTask("empty-tasks")).toBeNull();
    });

    it("returns the first in-progress task", () => {
      const planFile = writePlan(tmpDir, "with-tasks.md", `# With Tasks
Status: IN PROGRESS
Type: Feature

## Implementation Tasks

### 1. First task
- **Status:** complete

### 2. Second task
- **Status:** in-progress
- **Test Strategy:** Write unit tests first

### 3. Third task
- **Status:** pending
`);
      specStore.syncFromPlanFile(planFile, tmpDir);
      const task = specStore.getCurrentTask("with-tasks");
      expect(task).not.toBeNull();
      expect(task!.position).toBe(2);
      expect(task!.status).toBe("in-progress");
      expect(task!.testStrategy).toBe("Write unit tests first");
    });

    it("falls back to first pending when none in-progress", () => {
      const planFile = writePlan(tmpDir, "pending-tasks.md", `# Pending
Status: PENDING
Type: Feature

## Implementation Tasks

### 1. First task
- **Status:** pending

### 2. Second task
- **Status:** pending
`);
      specStore.syncFromPlanFile(planFile, tmpDir);
      const task = specStore.getCurrentTask("pending-tasks");
      expect(task).not.toBeNull();
      expect(task!.position).toBe(1);
    });
  });

  describe("updateTaskStatus", () => {
    it("updates a task's status", () => {
      const planFile = writePlan(tmpDir, "update-status.md", `# Update
Status: IN PROGRESS
Type: Feature

## Implementation Tasks

### 1. Task one
- **Status:** pending
`);
      specStore.syncFromPlanFile(planFile, tmpDir);
      specStore.updateTaskStatus("update-status", 1, "in-progress", { startedAt: 1000 });
      const task = specStore.getCurrentTask("update-status");
      expect(task!.status).toBe("in-progress");
      expect(task!.startedAt).toBe(1000);
    });
  });

  describe("syncFromPlanFile — rich task fields", () => {
    it("persists testStrategy and definitionOfDone", () => {
      const planFile = writePlan(tmpDir, "rich-fields.md", `# Rich Fields
Status: IN PROGRESS
Type: Feature

## Implementation Tasks

### 1. Create entity
- **Status:** pending
- **Test Strategy:** Unit test the entity schema
- **Definition of Done:** Entity validates correctly
`);
      specStore.syncFromPlanFile(planFile, tmpDir);
      const task = specStore.getCurrentTask("rich-fields");
      expect(task).not.toBeNull();
      expect(task!.testStrategy).toBe("Unit test the entity schema");
      expect(task!.definitionOfDone).toBe("Entity validates correctly");
    });
  });

  describe("getSpecsForSession", () => {
    it("returns specs associated with a session", () => {
      const planA = writePlan(tmpDir, "plan-a.md", `# Plan A\nStatus: IN PROGRESS\nType: Feature\n`);
      const planB = writePlan(tmpDir, "plan-b.md", `# Plan B\nStatus: PENDING\nType: Feature\n`);
      specStore.syncFromPlanFile(planA, tmpDir, "sess-1");
      specStore.syncFromPlanFile(planB, tmpDir, "sess-1");

      const specs = specStore.getSpecsForSession("sess-1");
      expect(specs).toHaveLength(2);
      const ids = specs.map((s) => s.id);
      expect(ids).toContain("plan-a");
      expect(ids).toContain("plan-b");
    });

    it("returns empty array for unknown session", () => {
      expect(specStore.getSpecsForSession("no-such-session")).toEqual([]);
    });

    it("does not return specs from other sessions", () => {
      const planA = writePlan(tmpDir, "sess-plan-a.md", `# A\nStatus: PENDING\nType: Feature\n`);
      const planB = writePlan(tmpDir, "sess-plan-b.md", `# B\nStatus: PENDING\nType: Feature\n`);
      specStore.syncFromPlanFile(planA, tmpDir, "sess-X");
      specStore.syncFromPlanFile(planB, tmpDir, "sess-Y");

      expect(specStore.getSpecsForSession("sess-X")).toHaveLength(1);
      expect(specStore.getSpecsForSession("sess-Y")).toHaveLength(1);
    });
  });

  describe("auditCompletion", () => {
    it("reports in-sync when md and sqlite agree", () => {
      const planFile = writePlan(tmpDir, "audit-sync.md", `# Audit Sync
Status: VERIFIED
Type: Feature

## Progress Tracking

- [x] Task 1: First task
- [x] Task 2: Second task
`);
      specStore.syncFromPlanFile(planFile, "/test/project");
      const result = specStore.auditCompletion("audit-sync");
      expect(result.inSync).toBe(true);
      expect(result.fixes).toHaveLength(0);
      expect(result.totalTasks).toBe(2);
      expect(result.completeTasks).toBe(2);
    });

    it("updates sqlite when md has [x] but sqlite has pending", () => {
      // First sync with unchecked tasks
      const planPath = join(tmpDir, "docs", "plans", "audit-md-ahead.md");
      mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
      writeFileSync(planPath, `# MD Ahead
Status: VERIFIED
Type: Feature

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task
`);
      specStore.syncFromPlanFile(planPath, "/test/project");

      // Now update the md to have [x] without re-syncing
      writeFileSync(planPath, `# MD Ahead
Status: VERIFIED
Type: Feature

## Progress Tracking

- [x] Task 1: First task
- [ ] Task 2: Second task
`);

      const result = specStore.auditCompletion("audit-md-ahead");
      expect(result.inSync).toBe(false);
      expect(result.fixes).toHaveLength(1);
      expect(result.fixes[0].issue).toBe("md-ahead");
      expect(result.fixes[0].taskPosition).toBe(1);
      expect(result.fixes[0].action).toBe("updated-sqlite");

      // Verify sqlite was updated
      const tasks = specStore.getTasksForSpec("audit-md-ahead");
      expect(tasks[0].status).toBe("complete");
      expect(tasks[1].status).toBe("pending");
    });

    it("updates md when sqlite has complete but md has [ ]", () => {
      const planPath = join(tmpDir, "docs", "plans", "audit-sqlite-ahead.md");
      mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
      writeFileSync(planPath, `# SQLite Ahead
Status: VERIFIED
Type: Feature

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task
`);
      specStore.syncFromPlanFile(planPath, "/test/project");

      // Manually mark task 2 as complete in sqlite
      specStore.updateTaskStatus("audit-sqlite-ahead", 2, "complete", { completedAt: Date.now() });

      const result = specStore.auditCompletion("audit-sqlite-ahead");
      expect(result.inSync).toBe(false);
      expect(result.fixes).toHaveLength(1);
      expect(result.fixes[0].issue).toBe("sqlite-ahead");
      expect(result.fixes[0].taskPosition).toBe(2);
      expect(result.fixes[0].action).toBe("updated-md");

      // Verify md was updated
      const content = readFileSync(planPath, "utf-8");
      expect(content).toContain("- [x] Task 2: Second task");
      expect(content).toContain("- [ ] Task 1: First task");
    });

    it("handles mixed discrepancies", () => {
      const planPath = join(tmpDir, "docs", "plans", "audit-mixed.md");
      mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
      writeFileSync(planPath, `# Mixed
Status: VERIFIED
Type: Feature

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task
- [ ] Task 3: Third task
`);
      specStore.syncFromPlanFile(planPath, "/test/project");

      // Mark task 1 complete in sqlite (sqlite-ahead)
      specStore.updateTaskStatus("audit-mixed", 1, "complete", { completedAt: Date.now() });

      // Update md to check task 3 (md-ahead)
      writeFileSync(planPath, `# Mixed
Status: VERIFIED
Type: Feature

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task
- [x] Task 3: Third task
`);

      const result = specStore.auditCompletion("audit-mixed");
      expect(result.inSync).toBe(false);
      expect(result.fixes).toHaveLength(2);

      const sqliteAhead = result.fixes.find((f) => f.issue === "sqlite-ahead");
      const mdAhead = result.fixes.find((f) => f.issue === "md-ahead");
      expect(sqliteAhead).toBeDefined();
      expect(sqliteAhead!.taskPosition).toBe(1);
      expect(mdAhead).toBeDefined();
      expect(mdAhead!.taskPosition).toBe(3);

      // Both should be synced now
      const content = readFileSync(planPath, "utf-8");
      expect(content).toContain("- [x] Task 1: First task");
      expect(content).toContain("- [x] Task 3: Third task");

      const tasks = specStore.getTasksForSpec("audit-mixed");
      expect(tasks[0].status).toBe("complete");
      expect(tasks[2].status).toBe("complete");
    });

    it("returns null-like result for unknown spec", () => {
      const result = specStore.auditCompletion("nonexistent");
      expect(result.totalTasks).toBe(0);
      expect(result.inSync).toBe(true);
      expect(result.fixes).toHaveLength(0);
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
