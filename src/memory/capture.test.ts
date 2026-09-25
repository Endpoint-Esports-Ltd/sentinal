/**
 * Capture Heuristics Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
  type ToolEvent,
} from "./capture.js";

// Real runner summaries. A PASSING bun run always prints " 0 fail", and a
// failing one can print " 0 pass" — a count of zero is not evidence of either.
const BUN_PASS =
  "bun test v1.3.10\n\n 12 pass\n 0 fail\n 30 expect() calls\nRan 12 tests across 3 files. [120.00ms]\n";
const BUN_FAIL =
  "bun test v1.3.10\n\n(fail) math > adds [0.10ms]\n 11 pass\n 1 fail\n 30 expect() calls\nRan 12 tests across 3 files.\n";
const BUN_ALL_FAIL =
  "bun test v1.3.10\n\n 0 pass\n 3 fail\nRan 3 tests across 1 file.\n";

const TSC =
  "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";

const matchesFail = (s: string) => TEST_FAIL_INDICATORS.some((r) => r.test(s));
const matchesPass = (s: string) => TEST_PASS_INDICATORS.some((r) => r.test(s));

describe("test outcome indicators", () => {
  it("does NOT read a passing bun run's ' 0 fail' as a failure", () => {
    expect(matchesFail(BUN_PASS)).toBe(false);
    expect(matchesPass(BUN_PASS)).toBe(true);
  });

  it("reads a bun run with failures as a failure", () => {
    expect(matchesFail(BUN_FAIL)).toBe(true);
  });

  it("does NOT read an all-failing bun run's ' 0 pass' as a pass", () => {
    expect(matchesFail(BUN_ALL_FAIL)).toBe(true);
    expect(matchesPass(BUN_ALL_FAIL)).toBe(false);
  });

  it("still recognises other runners' summaries", () => {
    expect(matchesFail("Tests: 2 failed, 10 passed, 12 total")).toBe(true);
    expect(matchesPass("Tests:       12 passed, 12 total")).toBe(true);
    expect(matchesFail("10 passed, 2 failed in 1.2s")).toBe(true);
  });
});

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

  it("hasRecentError excludes the current event and consumed errors", () => {
    const err = makeEvent({ success: false, exitCode: 1, output: "x" });
    buffer.push(err);
    expect(buffer.hasRecentError(3, { exclude: err })).toBeNull();

    const current = makeEvent();
    buffer.push(current);
    expect(buffer.hasRecentError(3, { exclude: current })).toBe(err);
    // The window counts PRIOR events only: `err` is the 4th prior event, so a
    // window of 4 reaches it once the current event takes no slot.
    buffer.push(makeEvent());
    buffer.push(makeEvent());
    const later = makeEvent();
    buffer.push(later);
    expect(buffer.hasRecentError(4, { exclude: later })).toBe(err);

    err.consumedBy = ["fix"];
    expect(buffer.hasRecentError(5, { exclude: later })).toBeNull();
    // Consumption is per consumer — a build-fix consumer still sees it.
    expect(
      buffer.hasRecentError(5, { exclude: later, consumer: "build" }),
    ).toBe(err);
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

    // ── D9 (hardening-sweep Task 11) ────────────────────────────────────
    // Callers PUSH the current event before analysing it (sentinal.ts,
    // memory-observer.ts), so these drive the buffer the same way.
    const pushAndAnalyze = (e: ToolEvent) => {
      buffer.push(e);
      return analyzeEvent(e, buffer);
    };
    const edit = (filePath: string) =>
      makeEvent({ toolName: "Edit", success: true, filePath });
    const fixesOf = (ds: ReturnType<typeof analyzeEvent>[]) =>
      ds.filter((d) => d.shouldCapture && d.title.startsWith("Fixed issue"));

    it("a passing bun run (exit 0) followed by edits → no fix", () => {
      pushAndAnalyze(
        makeEvent({ toolName: "bash", output: BUN_PASS, exitCode: 0 }),
      );
      const ds = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) =>
        pushAndAnalyze(edit(`src/${f}`)),
      );
      expect(fixesOf(ds)).toHaveLength(0);
    });

    it("a passing bun run with NO exit code followed by edits → no fix", () => {
      pushAndAnalyze(makeEvent({ toolName: "Bash", output: BUN_PASS }));
      const ds = ["a.ts", "b.ts"].map((f) => pushAndAnalyze(edit(`src/${f}`)));
      expect(fixesOf(ds)).toHaveLength(0);
    });

    it("exit 0 with error-looking text is not an error", () => {
      pushAndAnalyze(
        makeEvent({
          toolName: "bash",
          output: "grep: error TS2322 found in notes",
          exitCode: 0,
        }),
      );
      expect(fixesOf([pushAndAnalyze(edit("src/a.ts"))])).toHaveLength(0);
    });

    it("one real error + 4 edits → exactly one fix", () => {
      pushAndAnalyze(
        makeEvent({
          toolName: "bash",
          success: false,
          exitCode: 1,
          output: BUN_FAIL,
        }),
      );
      const ds = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) =>
        pushAndAnalyze(edit(`src/${f}`)),
      );
      const fixes = fixesOf(ds);
      expect(fixes).toHaveLength(1);
      expect(fixes[0].title).toBe("Fixed issue in a.ts");
    });

    it("an error streak (two failing runs) still yields one fix", () => {
      for (let i = 0; i < 2; i++)
        pushAndAnalyze(
          makeEvent({
            toolName: "bash",
            success: false,
            exitCode: 1,
            output: BUN_FAIL,
          }),
        );
      const ds = ["a.ts", "b.ts", "c.ts"].map((f) =>
        pushAndAnalyze(edit(`src/${f}`)),
      );
      expect(fixesOf(ds)).toHaveLength(1);
    });

    it("the consumed marker lives on the buffered event (survives JSON)", () => {
      pushAndAnalyze(
        makeEvent({
          toolName: "bash",
          success: false,
          exitCode: 1,
          output: BUN_FAIL,
        }),
      );
      pushAndAnalyze(edit("src/a.ts"));
      // Round-trip like the CC hook's per-checkout event-buffer.json.
      const reloaded = new EventBuffer(10);
      for (const e of JSON.parse(JSON.stringify(buffer.recent(10).reverse())))
        reloaded.push(e);
      const next = edit("src/b.ts");
      reloaded.push(next);
      expect(fixesOf([analyzeEvent(next, reloaded)])).toHaveLength(0);
    });

    it("a .md or docs/ edit after an error is not a fix — and does not consume it", () => {
      pushAndAnalyze(
        makeEvent({
          toolName: "bash",
          success: false,
          exitCode: 1,
          output: TSC,
        }),
      );
      expect(fixesOf([pushAndAnalyze(edit("README.md"))])).toHaveLength(0);
      expect(
        fixesOf([pushAndAnalyze(edit("docs/plans/2026-01-01-x.json"))]),
      ).toHaveLength(0);
      expect(fixesOf([pushAndAnalyze(edit("src/a.ts"))])).toHaveLength(1);
    });

    it("the current event is never its own error (an edit carrying issue text)", () => {
      // OpenCode puts non-blocking quality issues in an edit's output.
      const d = pushAndAnalyze(
        makeEvent({
          toolName: "edit",
          filePath: "src/a.ts",
          success: true,
          output: TSC,
        }),
      );
      expect(fixesOf([d])).toHaveLength(0);
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
          output:
            "FAIL src/auth.test.ts\n  1 fail\n  expect(received).toBe(expected)",
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
      expect(decision.confidence).toBeGreaterThanOrEqual(
        MIN_CAPTURE_CONFIDENCE,
      );
      expect(decision.filePaths).toContain("src/auth/auth.service.ts");
    });

    it("one fail → edits → pass → pass again yields ONE TDD capture (fail consumed)", () => {
      const run = (e: ToolEvent) => {
        buffer.push(e);
        return analyzeEvent(e, buffer);
      };
      run(
        makeEvent({
          toolName: "bash",
          success: false,
          exitCode: 1,
          output: BUN_FAIL,
        }),
      );
      run(makeEvent({ toolName: "edit", filePath: "src/math.ts" }));
      const first = run(
        makeEvent({ toolName: "bash", exitCode: 0, output: BUN_PASS }),
      );
      run(makeEvent({ toolName: "edit", filePath: "src/other.ts" }));
      const second = run(
        makeEvent({ toolName: "bash", exitCode: 0, output: BUN_PASS }),
      );
      expect(first.tags).toContain("tdd");
      expect(first.filePaths).toEqual(["src/math.ts"]);
      expect(second.tags ?? []).not.toContain("tdd");
    });

    it("a fail-looking run that exited 0 does not open a TDD cycle", () => {
      buffer.push(
        makeEvent({
          toolName: "bash",
          exitCode: 0,
          output: "FAIL src/x.test.ts",
        }),
      );
      buffer.push(makeEvent({ toolName: "edit", filePath: "src/x.ts" }));
      const pass = makeEvent({
        toolName: "bash",
        exitCode: 0,
        output: BUN_PASS,
      });
      buffer.push(pass);
      expect(analyzeEvent(pass, buffer).tags).not.toContain("tdd");
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

    it("a build error resolves ONCE; later successful builds do not re-capture", () => {
      const run = (e: ToolEvent) => {
        buffer.push(e);
        return analyzeEvent(e, buffer);
      };
      run(
        makeEvent({
          toolName: "bash",
          success: false,
          exitCode: 1,
          output: TSC,
        }),
      );
      const first = run(
        makeEvent({ toolName: "bash", exitCode: 0, output: "Build passed." }),
      );
      const second = run(
        makeEvent({ toolName: "bash", exitCode: 0, output: "Build passed." }),
      );
      expect(first.tags).toContain("build");
      expect(second.shouldCapture).toBe(false);
    });

    it("a Claude Code failure event (success:false, 'Exit code N') counts as the build error", () => {
      buffer.push(
        makeEvent({
          toolName: "Bash",
          success: false,
          output: "Exit code 2\nsomething broke",
        }),
      );
      const ok = makeEvent({
        toolName: "Bash",
        exitCode: 0,
        output: "Compiled successfully.",
      });
      buffer.push(ok);
      expect(analyzeEvent(ok, buffer).tags).toContain("build");
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
      buffer.push(
        makeEvent({
          toolName: "Bash",
          filePath,
          success: false,
          output: "error TS2345: type mismatch",
          timestamp: Date.now() - 2000,
        }),
      );
      buffer.push(
        makeEvent({
          toolName: "Edit",
          filePath,
          success: true,
          timestamp: Date.now() - 1500,
        }),
      );
      buffer.push(
        makeEvent({
          toolName: "Bash",
          filePath,
          success: false,
          output: "error TS2345: still failing",
          timestamp: Date.now() - 1000,
        }),
      );

      // 3rd error event triggers failed approach detection
      const event = makeEvent({
        toolName: "Bash",
        filePath,
        success: false,
        output: "error TS2345: third failure",
        timestamp: Date.now(),
      });
      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("pattern");
      expect(decision.tags).toContain("failed-approach");
      expect(decision.confidence).toBe(0.6);
    });

    it("should detect git restore/checkout as failed approach", () => {
      const buffer = new EventBuffer(20);
      const filePath = "src/auth/auth.service.ts";

      // Edit a file then git restore it
      buffer.push(
        makeEvent({
          toolName: "Edit",
          filePath,
          success: true,
          timestamp: Date.now() - 2000,
        }),
      );
      buffer.push(
        makeEvent({
          toolName: "Edit",
          filePath,
          success: true,
          timestamp: Date.now() - 1500,
        }),
      );

      // Git restore event
      const event = makeEvent({
        toolName: "Bash",
        success: true,
        output: `git restore src/auth/auth.service.ts`,
        timestamp: Date.now(),
      });
      const decision = analyzeEvent(event, buffer);

      expect(decision.shouldCapture).toBe(true);
      expect(decision.type).toBe("pattern");
      expect(decision.tags).toContain("failed-approach");
    });

    it("should NOT trigger on normal iterative development (error, fix, success)", () => {
      const buffer = new EventBuffer(20);
      const filePath = "src/auth/auth.service.ts";

      // Error → edit → success (normal iteration, not failed approach)
      buffer.push(
        makeEvent({
          toolName: "Bash",
          filePath,
          success: false,
          output: "error TS2345",
          timestamp: Date.now() - 3000,
        }),
      );
      buffer.push(
        makeEvent({
          toolName: "Edit",
          filePath,
          success: true,
          timestamp: Date.now() - 2000,
        }),
      );
      buffer.push(
        makeEvent({
          toolName: "Bash",
          filePath,
          success: true,
          output: "tests passed",
          timestamp: Date.now() - 1000,
        }),
      );

      // Another edit — should NOT trigger (there was a success between errors)
      const event = makeEvent({
        toolName: "Edit",
        filePath,
        success: true,
        timestamp: Date.now(),
      });
      const decision = analyzeEvent(event, buffer);

      // Should NOT be a failed-approach capture
      if (decision.shouldCapture) {
        expect(decision.tags).not.toContain("failed-approach");
      }
    });
  });
});
