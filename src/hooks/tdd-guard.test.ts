/**
 * TDD Guard Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { processTddGuard, type TddGuardInput } from "./tdd-guard.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sentinal-tdd-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const activePlanContent = `# Active Spec
Status: IN PROGRESS
Type: Feature

## Implementation Tasks

### 1. First task
- **Status:** in-progress
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("processTddGuard — pass-through cases (no blocking)", () => {
  it("returns null for non-edit tools", () => {
    expect(processTddGuard({ toolName: "Read", filePath: "src/foo.ts", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Bash", filePath: "src/foo.ts", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Glob", filePath: "src/foo.ts", cwd: "/proj" })).toBeNull();
  });

  it("returns null when filePath is undefined", () => {
    expect(processTddGuard({ toolName: "Write", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Edit", cwd: "/proj" })).toBeNull();
  });

  it("returns null for test files (always allowed)", () => {
    expect(processTddGuard({ toolName: "Write", filePath: "src/foo.test.ts", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Edit", filePath: "src/bar.spec.ts", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "MultiEdit", filePath: "src/baz.test.tsx", cwd: "/proj" })).toBeNull();
  });

  it("returns null for non-TypeScript files", () => {
    expect(processTddGuard({ toolName: "Write", filePath: "src/foo.js", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Edit", filePath: "README.md", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Write", filePath: "src/styles.css", cwd: "/proj" })).toBeNull();
    expect(processTddGuard({ toolName: "Write", filePath: "src/component.html", cwd: "/proj" })).toBeNull();
  });
});

describe("processTddGuard — no active spec (no blocking)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, "test.db");
    // Initialize DB but don't sync any spec
    const store = new MemoryStore(dbPath);
    store.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no active spec in project", () => {
    const input: TddGuardInput = {
      toolName: "Write",
      filePath: "src/foo.ts",
      cwd: tmpDir,
      dbPath,
    };
    expect(processTddGuard(input)).toBeNull();
  });
});

describe("processTddGuard — with active spec", () => {
  let tmpDir: string;
  let dbPath: string;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, "test.db");
    memoryStore = new MemoryStore(dbPath);

    const specStore = new SpecStore(memoryStore);
    const planFile = writePlan(tmpDir, "active-spec.md", activePlanContent);
    specStore.syncFromPlanFile(planFile, tmpDir);
    memoryStore.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when state is RED_CONFIRMED (allowed)", () => {
    const store = new MemoryStore(dbPath);
    store.setTddState({ filePath: "src/foo.ts", state: "RED_CONFIRMED" });
    store.close();

    const result = processTddGuard({
      toolName: "Edit",
      filePath: "src/foo.ts",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).toBeNull();
  });

  it("blocks when state is IDLE (no test written)", () => {
    const result = processTddGuard({
      toolName: "Write",
      filePath: "src/foo.ts",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).not.toBeNull();
    expect(result!.permissionDecision).toBe("deny");
    expect(result!.reason).toContain("no test has been written yet");
    expect(result!.reason).toContain("Sentinal TDD Guard");
  });

  it("blocks when state is TEST_WRITTEN (not yet confirmed failing)", () => {
    const store = new MemoryStore(dbPath);
    store.setTddState({ filePath: "src/auth.ts", state: "TEST_WRITTEN" });
    store.close();

    const result = processTddGuard({
      toolName: "Edit",
      filePath: "src/auth.ts",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("run the test suite first");
  });

  it("blocks when state is GREEN_CONFIRMED (cycle done, write next test)", () => {
    const store = new MemoryStore(dbPath);
    store.setTddState({ filePath: "src/auth.ts", state: "GREEN_CONFIRMED" });
    store.close();

    const result = processTddGuard({
      toolName: "Edit",
      filePath: "src/auth.ts",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("write a new failing test");
  });

  it("deny message includes RED-GREEN-REFACTOR instructions", () => {
    const result = processTddGuard({
      toolName: "Write",
      filePath: "src/new-feature.ts",
      cwd: tmpDir,
      dbPath,
    });
    expect(result!.reason).toContain("RED-GREEN-REFACTOR");
    expect(result!.reason).toContain("failing test");
    expect(result!.reason).toContain("FAILS");
  });

  it("allows Write tool as well as Edit", () => {
    const store = new MemoryStore(dbPath);
    store.setTddState({ filePath: "src/foo.ts", state: "RED_CONFIRMED" });
    store.close();

    expect(processTddGuard({ toolName: "Write", filePath: "src/foo.ts", cwd: tmpDir, dbPath })).toBeNull();
    expect(processTddGuard({ toolName: "MultiEdit", filePath: "src/foo.ts", cwd: tmpDir, dbPath })).toBeNull();
  });

  it("allows .tsx files when RED_CONFIRMED", () => {
    const store = new MemoryStore(dbPath);
    store.setTddState({ filePath: "src/component.tsx", state: "RED_CONFIRMED" });
    store.close();

    const result = processTddGuard({
      toolName: "Edit",
      filePath: "src/component.tsx",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).toBeNull();
  });

  it("blocks .tsx files when IDLE", () => {
    const result = processTddGuard({
      toolName: "Edit",
      filePath: "src/component.tsx",
      cwd: tmpDir,
      dbPath,
    });
    expect(result).not.toBeNull();
  });
});
