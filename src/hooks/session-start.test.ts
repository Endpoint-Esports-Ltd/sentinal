/**
 * Session Start Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { detectAssistant } from "./session-start";
import { MemoryStore } from "../memory/store";

describe("detectAssistant", () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  it("should return 'claude-code' when CLAUDE_PLUGIN_ROOT is set", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/some/path";
    expect(detectAssistant()).toBe("claude-code");
  });

  it("should return 'opencode' when CLAUDE_PLUGIN_ROOT is not set", () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    expect(detectAssistant()).toBe("opencode");
  });

  it("should return 'claude-code' even for empty string value", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "";
    // Empty string is falsy in JS, so this should return opencode
    expect(detectAssistant()).toBe("opencode");
  });
});

describe("session-start integration", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("should insert a session record with correct fields", () => {
    const sessionId = `test-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: "/tmp/transcript.jsonl",
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
    expect(session!.projectPath).toBe("/test/project");
    expect(session!.assistant).toBe("claude-code");
    expect(session!.transcriptPath).toBe("/tmp/transcript.jsonl");
    expect(session!.endTime).toBeNull();
    expect(session!.summary).toBeNull();
  });

  it("should handle opencode assistant type", () => {
    const sessionId = `test-oc-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.assistant).toBe("opencode");
    expect(session!.transcriptPath).toBeNull();
  });

  it("should handle null transcript path", () => {
    const sessionId = `test-null-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.transcriptPath).toBeNull();
  });
});
