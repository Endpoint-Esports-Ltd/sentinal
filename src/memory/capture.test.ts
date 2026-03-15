/**
 * Capture Heuristics Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  type ToolEvent,
} from "./capture.js";

function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolName: "Edit",
    filePath: "src/auth/auth.service.ts",
    success: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(5);
  });

  it("should store events up to max size", () => {
    for (let i = 0; i < 7; i++) {
      buffer.push(makeEvent({ timestamp: i }));
    }
    expect(buffer.size).toBe(5);
  });

  it("should return recent events most-recent first", () => {
    buffer.push(makeEvent({ timestamp: 1 }));
    buffer.push(makeEvent({ timestamp: 2 }));
    buffer.push(makeEvent({ timestamp: 3 }));

    const recent = buffer.recent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].timestamp).toBe(3);
    expect(recent[1].timestamp).toBe(2);
  });

  it("should detect recent errors", () => {
    buffer.push(makeEvent({ success: true }));
    buffer.push(
      makeEvent({
        success: false,
        output: "error TS2345: Argument of type",
      }),
    );
    buffer.push(makeEvent({ success: true }));

    const error = buffer.hasRecentError(3);
    expect(error).not.toBeNull();
  });

  it("should return null when no recent errors", () => {
    buffer.push(makeEvent({ success: true }));
    buffer.push(makeEvent({ success: true }));

    expect(buffer.hasRecentError(3)).toBeNull();
  });

  it("should clear events", () => {
    buffer.push(makeEvent());
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});

describe("analyzeEvent", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    buffer = new EventBuffer(10);
  });

  describe("error-fix sequence", () => {
    it("should detect error followed by fix", () => {
      // First: an error event
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: false,
          output: "error TS2345: Argument of type 'string' is not assignable",
          filePath: "src/auth/auth.service.ts",
        }),
      );

      // Then: a successful edit
      const fixEvent = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "src/auth/auth.service.ts",
      });

      const decision = analyzeEvent(fixEvent, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("fix");
      expect(decision.confidence).toBeGreaterThanOrEqual(
        MIN_CAPTURE_CONFIDENCE,
      );
      expect(decision.filePaths).toContain("src/auth/auth.service.ts");
      expect(decision.tags).toContain("fix");
    });

    it("should not trigger without prior error", () => {
      buffer.push(makeEvent({ success: true }));

      const editEvent = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "src/test.ts",
      });

      const decision = analyzeEvent(editEvent, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  describe("config change", () => {
    it("should detect tsconfig changes", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "tsconfig.json",
      });

      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("decision");
      expect(decision.tags).toContain("config");
    });

    it("should detect package.json changes", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "package.json",
      });

      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("decision");
    });

    it("should detect angular.json changes", () => {
      const event = makeEvent({
        toolName: "Write",
        success: true,
        filePath: "angular.json",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(true);
    });

    it("should not trigger for regular files", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "src/app/user.service.ts",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  describe("architectural file creation", () => {
    it("should detect new module creation", () => {
      const event = makeEvent({
        toolName: "Write",
        success: true,
        filePath: "src/auth/auth.module.ts",
      });

      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("discovery");
      expect(decision.tags).toContain("architecture");
    });

    it("should detect new guard creation", () => {
      const event = makeEvent({
        toolName: "Write",
        success: true,
        filePath: "src/auth/auth.guard.ts",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(true);
    });

    it("should NOT trigger on edit of existing architectural file", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: "src/auth/auth.module.ts",
      });

      // Edit event preceded by no errors, no config match → should not capture
      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  describe("TDD cycle", () => {
    it("should detect test fail → edit → test pass", () => {
      // 1. Test run fails
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: true,
          output: "FAIL src/auth.test.ts\n  1 fail\n  expect(received).toBe(expected)",
        }),
      );

      // 2. Edit implementation
      buffer.push(
        makeEvent({
          toolName: "Edit",
          success: true,
          filePath: "src/auth/auth.service.ts",
        }),
      );

      // 3. Test run passes
      const passEvent = makeEvent({
        toolName: "Bash",
        success: true,
        output: "PASS src/auth.test.ts\n  5 pass\n  0 fail",
      });

      const decision = analyzeEvent(passEvent, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("fix");
      expect(decision.tags).toContain("tdd");
      expect(decision.confidence).toBeGreaterThanOrEqual(MIN_CAPTURE_CONFIDENCE);
      expect(decision.filePaths).toContain("src/auth/auth.service.ts");
    });

    it("should not trigger without edit between fail and pass", () => {
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: true,
          output: "1 fail\nexpect(received).toBe(expected)",
        }),
      );

      // No edit in between — just another test run
      const passEvent = makeEvent({
        toolName: "Bash",
        success: true,
        output: "5 pass\n0 fail",
      });

      const decision = analyzeEvent(passEvent, buffer);
      expect(decision.shouldCapture).toBe(false);
    });

    it("should not trigger without prior test failure", () => {
      buffer.push(
        makeEvent({
          toolName: "Edit",
          success: true,
          filePath: "src/foo.ts",
        }),
      );

      const passEvent = makeEvent({
        toolName: "Bash",
        success: true,
        output: "5 pass\nall tests passed",
      });

      const decision = analyzeEvent(passEvent, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  describe("build fix sequence", () => {
    it("should detect build error followed by success", () => {
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: false,
          output: "ERROR: Build failed\nerror TS2322: Type 'string'",
        }),
      );

      const successEvent = makeEvent({
        toolName: "Bash",
        success: true,
        output: "Compiled successfully. Build passed.",
      });

      const decision = analyzeEvent(successEvent, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("fix");
      expect(decision.tags).toContain("build");
    });

    it("should not trigger without prior build error", () => {
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: true,
          output: "Compiled successfully.",
        }),
      );

      const event = makeEvent({
        toolName: "Bash",
        success: true,
        output: "Build passed.",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  describe("no capture cases", () => {
    it("should not capture failed tool events", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: false,
        filePath: "src/test.ts",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });

    it("should not capture events without file paths", () => {
      const event = makeEvent({
        toolName: "Edit",
        success: true,
        filePath: undefined,
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });

    it("should not capture Read events", () => {
      const event = makeEvent({
        toolName: "Read",
        success: true,
        filePath: "src/test.ts",
      });

      const decision = analyzeEvent(event, buffer);
      expect(decision.shouldCapture).toBe(false);
    });
  });

  // ─── Failed Approach Detection ────────────────────────────────────────

  describe("detectFailedApproach", () => {
    it("should detect repeated errors on the same file (3+ errors)", () => {
      const buffer = new EventBuffer(20);
      const filePath = "src/auth/auth.service.ts";

      // 2 error events in buffer
      buffer.push(makeEvent({ toolName: "Bash", filePath, success: false, output: "error TS2345: type mismatch", timestamp: Date.now() - 2000 }));
      buffer.push(makeEvent({ toolName: "Edit", filePath, success: true, timestamp: Date.now() - 1500 }));
      buffer.push(makeEvent({ toolName: "Bash", filePath, success: false, output: "error TS2345: still failing", timestamp: Date.now() - 1000 }));

      // 3rd error event triggers failed approach detection
      const event = makeEvent({ toolName: "Bash", filePath, success: false, output: "error TS2345: third failure", timestamp: Date.now() });
      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("pattern");
      expect(decision.tags).toContain("failed-approach");
      expect(decision.confidence).toBe(0.60);
    });

    it("should detect git restore/checkout as failed approach", () => {
      const buffer = new EventBuffer(20);
      const filePath = "src/auth/auth.service.ts";

      // Edit a file then git restore it
      buffer.push(makeEvent({ toolName: "Edit", filePath, success: true, timestamp: Date.now() - 2000 }));
      buffer.push(makeEvent({ toolName: "Edit", filePath, success: true, timestamp: Date.now() - 1500 }));

      // Git restore event
      const event = makeEvent({ toolName: "Bash", success: true, output: `git restore src/auth/auth.service.ts`, timestamp: Date.now() });
      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("pattern");
      expect(decision.tags).toContain("failed-approach");
    });

    it("should NOT trigger on normal iterative development (error, fix, success)", () => {
      const buffer = new EventBuffer(20);
      const filePath = "src/auth/auth.service.ts";

      // Error → edit → success (normal iteration, not failed approach)
      buffer.push(makeEvent({ toolName: "Bash", filePath, success: false, output: "error TS2345", timestamp: Date.now() - 3000 }));
      buffer.push(makeEvent({ toolName: "Edit", filePath, success: true, timestamp: Date.now() - 2000 }));
      buffer.push(makeEvent({ toolName: "Bash", filePath, success: true, output: "tests passed", timestamp: Date.now() - 1000 }));

      // Another edit — should NOT trigger (there was a success between errors)
      const event = makeEvent({ toolName: "Edit", filePath, success: true, timestamp: Date.now() });
      const decision = analyzeEvent(event, buffer);

      // Should NOT be a failed-approach capture
      if (decision.shouldCapture) {
        expect(decision.tags).not.toContain("failed-approach");
      }
    });
  });
});
