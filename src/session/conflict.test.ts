/**
 * Session Conflict Detection Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
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

    const result = detectFileConflict(store, "src/app.ts", "/test/project", "session-1");
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

    const result = detectFileConflict(store, "src/app.ts", "/test/project", "session-2");
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

    const result = detectFileConflict(store, "src/app.ts", "/test/project", "session-2");
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

    const result = detectFileConflict(store, "src/app.ts", "/test/project", "session-2");
    expect(result).toBeNull();
  });
});
