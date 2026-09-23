/**
 * Session Conflict Detection Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { makeTmpDir } from "../test-helpers.js";
import { detectSessionConflict, detectFileConflict } from "./conflict.js";

describe("detectSessionConflict", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("should return null when no other active sessions exist", () => {
    store.insertSession({
      id: "session-1",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectSessionConflict(store, "/test/project", "session-1");
    expect(result).toBeNull();
  });

  it("should detect another active session on the same project", () => {
    store.insertSession({
      id: "session-1",
      startTime: Date.now() - 60000,
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    store.insertSession({
      id: "session-2",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    const result = detectSessionConflict(store, "/test/project", "session-2");
    expect(result).not.toBeNull();
    expect(result!.conflictingSessions).toHaveLength(1);
    expect(result!.conflictingSessions[0].id).toBe("session-1");
    expect(result!.message).toContain("session-1");
  });

  it("should not detect ended sessions as conflicts", () => {
    store.insertSession({
      id: "session-old",
      startTime: Date.now() - 120000,
      endTime: Date.now() - 60000,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    store.insertSession({
      id: "session-new",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectSessionConflict(store, "/test/project", "session-new");
    expect(result).toBeNull();
  });

  it("should not detect sessions on different projects", () => {
    store.insertSession({
      id: "session-a",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/project-a",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    store.insertSession({
      id: "session-b",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/project-b",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    const result = detectSessionConflict(store, "/project-b", "session-b");
    expect(result).toBeNull();
  });

  it("should include assistant type in warning message", () => {
    store.insertSession({
      id: "other-session",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    store.insertSession({
      id: "my-session",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectSessionConflict(store, "/test/project", "my-session");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("opencode");
  });
});

// ─── File-Level Conflict Detection ────────────────────────────────────────────

describe("detectFileConflict", () => {
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
  });

  it("should return null when no other sessions edited the file", () => {
    store.insertSession({
      id: "session-1",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectFileConflict(
      store,
      "src/app.ts",
      "/test/project",
      "session-1",
    );
    expect(result).toBeNull();
  });

  it("should detect when another active session recently edited the same file", () => {
    // Session 1 — edited file 2 minutes ago
    store.insertSession({
      id: "session-1",
      startTime: Date.now() - 300000,
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    service.addObservation({
      sessionId: "session-1",
      projectPath: "/test/project",
      timestamp: Date.now() - 120000, // 2 min ago
      type: "discovery",
      title: "Edited app.ts",
      content: "Made changes",
      filePaths: ["src/app.ts"],
      tags: [],
      metadata: {},
    });

    // Session 2 — current session
    store.insertSession({
      id: "session-2",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectFileConflict(
      store,
      "src/app.ts",
      "/test/project",
      "session-2",
    );
    expect(result).not.toBeNull();
    expect(result!.message).toContain("app.ts");
    expect(result!.sessionId).toBe("session-1");
  });

  it("should not detect edits older than 5 minutes", () => {
    store.insertSession({
      id: "session-1",
      startTime: Date.now() - 600000,
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    service.addObservation({
      sessionId: "session-1",
      projectPath: "/test/project",
      timestamp: Date.now() - 600000, // 10 min ago
      type: "discovery",
      title: "Old edit",
      content: "content",
      filePaths: ["src/app.ts"],
      tags: [],
      metadata: {},
    });

    store.insertSession({
      id: "session-2",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectFileConflict(
      store,
      "src/app.ts",
      "/test/project",
      "session-2",
    );
    expect(result).toBeNull();
  });

  it("should not detect edits from ended sessions", () => {
    store.insertSession({
      id: "session-1",
      startTime: Date.now() - 120000,
      endTime: Date.now() - 60000, // ended
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    service.addObservation({
      sessionId: "session-1",
      projectPath: "/test/project",
      timestamp: Date.now() - 90000, // recent but session ended
      type: "discovery",
      title: "Edited before ending",
      content: "content",
      filePaths: ["src/app.ts"],
      tags: [],
      metadata: {},
    });

    store.insertSession({
      id: "session-2",
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const result = detectFileConflict(
      store,
      "src/app.ts",
      "/test/project",
      "session-2",
    );
    expect(result).toBeNull();
  });
});

// ─── Worktree-aware project keys ──────────────────────────────────────────────

/**
 * Both detectors filter on `project_path` with EXACT equality, against a path
 * the caller hands them straight from a hook's `cwd` (`src/hooks/session-start.ts:42`,
 * `src/cli/commands/hook.ts:200`). From a linked worktree that cwd is the
 * worktree path, while every row is written under the CANONICAL main-checkout
 * key (Wave 3), so both detectors silently returned "no conflict" forever.
 *
 * Fixtures are REAL git repos with REAL linked worktrees: a fake path proves
 * nothing, because `resolveProjectIdentity("/test")` returns `/test` unchanged.
 */
function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir });
}

describe("conflict detection project identity", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtPath: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    // realpathSync pre-applied: /var is a symlink to /private/var on macOS and
    // resolveProjectIdentity canonicalizes, so raw tmp paths never compare equal.
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    wtPath = join(tmpDir, "wt-feature");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature"], {
      cwd: repoDir,
    });

    store = new MemoryStore(":memory:");
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detectSessionConflict finds a canonically-keyed session when called with a worktree path", () => {
    store.insertSession({
      id: "session-main",
      startTime: Date.now() - 60000,
      endTime: null,
      projectPath: repoDir, // canonical key, as Wave 3 writes it
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    // Caller stands in the linked worktree and passes ITS cwd.
    const result = detectSessionConflict(store, wtPath, "session-worktree");

    expect(result).not.toBeNull();
    expect(result!.conflictingSessions.map((s) => s.id)).toEqual([
      "session-main",
    ]);
  }, 20_000);

  it("detectFileConflict finds a canonically-keyed observation when called with a worktree path", () => {
    store.insertSession({
      id: "session-main",
      startTime: Date.now() - 300000,
      endTime: null,
      projectPath: repoDir,
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    service.addObservation({
      sessionId: "session-main",
      projectPath: repoDir, // canonical key
      timestamp: Date.now() - 60000,
      type: "discovery",
      title: "Edited app.ts",
      content: "Made changes",
      filePaths: ["src/app.ts"],
      tags: [],
      metadata: {},
    });

    const result = detectFileConflict(
      store,
      "src/app.ts",
      wtPath, // worktree cwd
      "session-worktree",
    );

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-main");
  }, 20_000);

  it("detectFileConflict still matches file_paths, not the project key, on the LIKE clause", () => {
    store.insertSession({
      id: "session-main",
      startTime: Date.now() - 300000,
      endTime: null,
      projectPath: repoDir,
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });
    service.addObservation({
      sessionId: "session-main",
      projectPath: repoDir,
      timestamp: Date.now() - 60000,
      type: "discovery",
      title: "Edited app.ts",
      content: "Made changes",
      filePaths: ["src/app.ts"],
      tags: [],
      metadata: {},
    });

    // A DIFFERENT file in the same (canonical) project must not match. This
    // pins that normalization was applied to the project key only — if the
    // file path were canonicalized too it would resolve to the repo root and
    // match everything.
    const result = detectFileConflict(
      store,
      "src/other.ts",
      wtPath,
      "session-worktree",
    );

    expect(result).toBeNull();
  }, 20_000);
});
