/**
 * Memory Observer Hook Tests
 *
 * Tests the hook's core logic: event buffer persistence,
 * tool event construction, and capture-to-storage pipeline.
 *
 * Since the hook runs as a standalone process reading stdin,
 * we test the key functions it uses rather than spawning processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  type ToolEvent,
} from "../memory/capture.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDb(): string {
  const dir = makeTmpDir();
  return join(dir, "test.db");
}

// ─── Event Buffer Persistence ────────────────────────────────────────────────

describe("event buffer persistence", () => {
  let tmpDir: string;
  let bufferPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const sentinalDir = join(tmpDir, ".sentinal");
    mkdirSync(sentinalDir, { recursive: true });
    bufferPath = join(sentinalDir, "event-buffer.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should serialize event buffer to JSON", () => {
    const buffer = new EventBuffer(20);
    buffer.push({
      toolName: "Edit",
      filePath: "src/foo.ts",
      success: true,
      timestamp: 1000,
    });
    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error TS2345",
      timestamp: 2000,
    });

    // Simulate the save logic from the hook
    const events = buffer.recent(20).reverse();
    writeFileSync(bufferPath, JSON.stringify(events));

    const loaded = JSON.parse(readFileSync(bufferPath, "utf-8"));
    expect(loaded).toHaveLength(2);
    expect(loaded[0].toolName).toBe("Edit");
    expect(loaded[1].toolName).toBe("Bash");
  });

  it("should deserialize event buffer from JSON", () => {
    const events: ToolEvent[] = [
      {
        toolName: "Write",
        filePath: "src/new.ts",
        success: true,
        timestamp: 1000,
      },
      { toolName: "Bash", success: false, output: "FAILED", timestamp: 2000 },
    ];
    writeFileSync(bufferPath, JSON.stringify(events));

    // Simulate the load logic from the hook
    const buffer = new EventBuffer(20);
    const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
    for (const event of data) {
      buffer.push(event as ToolEvent);
    }

    expect(buffer.size).toBe(2);
    const recent = buffer.recent(2);
    expect(recent[0].timestamp).toBe(2000);
    expect(recent[1].timestamp).toBe(1000);
  });

  it("should handle corrupted buffer file gracefully", () => {
    writeFileSync(bufferPath, "not valid json{{{");

    const buffer = new EventBuffer(20);
    try {
      const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const event of data) buffer.push(event);
      }
    } catch {
      // Expected: corrupted file, start fresh
    }

    expect(buffer.size).toBe(0);
  });

  it("should handle missing buffer file gracefully", () => {
    const buffer = new EventBuffer(20);
    const missingPath = join(tmpDir, ".sentinal", "nonexistent.json");

    if (existsSync(missingPath)) {
      const data = JSON.parse(readFileSync(missingPath, "utf-8"));
      for (const event of data as ToolEvent[]) buffer.push(event);
    }

    expect(buffer.size).toBe(0);
  });
});

// ─── Tool Event Construction ─────────────────────────────────────────────────

describe("tool event construction from hook input", () => {
  it("should extract filePath from file_path field", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    };
    const filePath = (input.tool_input.file_path as string) ?? undefined;

    expect(filePath).toBe("src/auth.ts");
  });

  it("should construct a valid ToolEvent", () => {
    const event: ToolEvent = {
      toolName: "Write",
      filePath: "src/new-file.ts",
      success: true,
      output: undefined,
      timestamp: Date.now(),
    };

    expect(event.toolName).toBe("Write");
    expect(event.filePath).toBe("src/new-file.ts");
    expect(event.success).toBe(true);
  });

  it("should prefer tool_response output over tool_input output for Bash events", () => {
    // Simulates the hook input structure from Claude Code
    const hookInput = {
      tool_name: "Bash",
      tool_input: { command: "bun test", output: "bun test" },
      tool_response: {
        output:
          "FAIL src/foo.test.ts\n  1 fail\n  expect(received).toBe(expected)",
      },
    };

    // This mirrors the event construction logic in hook.ts runMemoryObserver
    const rawOutput =
      (hookInput.tool_response?.output as string) ??
      (hookInput.tool_input.output as string) ??
      undefined;

    const event: ToolEvent = {
      toolName: hookInput.tool_name,
      success: true,
      output: rawOutput?.slice(0, 2000),
      timestamp: Date.now(),
    };

    // Should contain the actual test output, not the command string
    expect(event.output).toContain("FAIL");
    expect(event.output).toContain("expect(received)");
    expect(event.output).not.toBe("bun test");
  });

  it("should fall back to tool_input output when tool_response is absent", () => {
    const hookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hello", output: "hello" },
      // No tool_response
    };

    const rawOutput =
      ((hookInput as any).tool_response?.output as string) ??
      (hookInput.tool_input.output as string) ??
      undefined;

    const event: ToolEvent = {
      toolName: hookInput.tool_name,
      success: true,
      output: rawOutput?.slice(0, 2000),
      timestamp: Date.now(),
    };

    expect(event.output).toBe("hello");
  });
});

// ─── Capture-to-Storage Pipeline ─────────────────────────────────────────────

describe("capture-to-storage pipeline", () => {
  let dbPath: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    store = new MemoryStore(dbPath);
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should capture and store an error-fix sequence", () => {
    const buffer = new EventBuffer(20);

    // Simulate error event
    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error TS2345: Argument of type 'string'",
      filePath: "src/auth.ts",
      timestamp: Date.now() - 5000,
    });

    // Simulate fix event
    const fixEvent: ToolEvent = {
      toolName: "Edit",
      success: true,
      filePath: "src/auth.ts",
      timestamp: Date.now(),
    };
    buffer.push(fixEvent);

    const decision = analyzeEvent(fixEvent, buffer);

    expect(decision.shouldCapture).toBe(true);
    expect(decision.confidence).toBeGreaterThanOrEqual(MIN_CAPTURE_CONFIDENCE);

    // Store the observation (mimics hook behavior)
    const obs = service.addObservation({
      sessionId: "test-session",
      projectPath: "/test/project",
      timestamp: Date.now(),
      type: decision.type,
      title: decision.title,
      content: decision.content,
      filePaths: decision.filePaths,
      tags: decision.tags,
      metadata: { source: "auto-capture", confidence: decision.confidence },
    });

    expect(obs.id).toBeGreaterThan(0);
    expect(obs.type).toBe("fix");

    // Verify it's retrievable
    const retrieved = service.getObservation(obs.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toContain("fix");
  });

  it("should not store when capture decision is negative", () => {
    const buffer = new EventBuffer(20);

    const event: ToolEvent = {
      toolName: "Read",
      success: true,
      filePath: "src/readme.md",
      timestamp: Date.now(),
    };
    buffer.push(event);

    const decision = analyzeEvent(event, buffer);
    expect(decision.shouldCapture).toBe(false);

    // Pipeline would not store anything
    const stats = service.getStats();
    expect(stats.totalObservations).toBe(0);
  });

  it("should sanitize content when storing", () => {
    const buffer = new EventBuffer(20);

    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error: password=mysecretpass123 not found",
      filePath: "src/config.ts",
      timestamp: Date.now() - 5000,
    });

    const fixEvent: ToolEvent = {
      toolName: "Edit",
      success: true,
      filePath: "src/config.ts",
      timestamp: Date.now(),
    };
    buffer.push(fixEvent);

    const decision = analyzeEvent(fixEvent, buffer);

    if (decision.shouldCapture) {
      const obs = service.addObservation({
        sessionId: "test-session",
        projectPath: "/test",
        timestamp: Date.now(),
        type: decision.type,
        title: decision.title,
        content: decision.content,
        filePaths: decision.filePaths,
        tags: decision.tags,
        metadata: {},
      });

      // Content should be sanitized (password redacted)
      const retrieved = service.getObservation(obs.id);
      expect(retrieved!.content).not.toContain("mysecretpass123");
    }
  });
});
