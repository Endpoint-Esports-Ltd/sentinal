import { describe, expect, it, mock, afterEach } from "bun:test";
import {
  deny,
  hint,
  block,
  denyExit,
  blockExit,
  bashOutputOf,
  type HookInput,
} from "./hook-output";

describe("hook-output", () => {
  describe("deny", () => {
    it("should return PreToolUse deny JSON", () => {
      const result = deny("Tool blocked");
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Tool blocked",
      });
    });
  });

  describe("hint", () => {
    it("should return hint JSON with additionalContext", () => {
      const result = hint("PreToolUse", "Consider using Vexor");
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Consider using Vexor",
        },
      });
    });

    it("should return PostToolUse context JSON", () => {
      const result = hint("PostToolUse", "File too long");
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "File too long",
        },
      });
    });
  });

  describe("denyExit", () => {
    let stderrChunks: string[];
    let stdoutChunks: string[];
    const origStderrWrite = process.stderr.write;
    const origStdoutWrite = process.stdout.write;
    const origExit = process.exit;

    afterEach(() => {
      process.stderr.write = origStderrWrite;
      process.stdout.write = origStdoutWrite;
      process.exit = origExit;
    });

    it("should write reason to stderr and JSON to stdout", () => {
      stderrChunks = [];
      stdoutChunks = [];
      process.stderr.write = ((s: string) => {
        stderrChunks.push(s);
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((s: string) => {
        stdoutChunks.push(s);
        return true;
      }) as typeof process.stdout.write;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
      }) as typeof process.exit;

      denyExit("Tool blocked");

      expect(stderrChunks.join("")).toBe("Tool blocked");
      expect(stdoutChunks.join("")).toBe(
        JSON.stringify({ permissionDecision: "deny", reason: "Tool blocked" }),
      );
      expect(exitCode).toBe(2);
    });

    it("should write block reason to stderr", () => {
      stderrChunks = [];
      stdoutChunks = [];
      process.stderr.write = ((s: string) => {
        stderrChunks.push(s);
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((s: string) => {
        stdoutChunks.push(s);
        return true;
      }) as typeof process.stdout.write;
      let exitCode2: number | undefined;
      process.exit = ((code?: number) => {
        exitCode2 = code;
      }) as typeof process.exit;

      denyExit("Cannot stop during active spec");

      expect(stderrChunks.join("")).toBe("Cannot stop during active spec");
      expect(exitCode2).toBe(2);
    });
  });

  describe("block", () => {
    it("should return block decision JSON", () => {
      const result = block("Cannot stop during active spec");
      expect(result).toEqual({
        decision: "block",
        reason: "Cannot stop during active spec",
      });
    });
  });

  describe("blockExit", () => {
    let stderrChunks: string[];
    let stdoutChunks: string[];
    const origStderrWrite = process.stderr.write;
    const origStdoutWrite = process.stdout.write;
    const origExit = process.exit;

    afterEach(() => {
      process.stderr.write = origStderrWrite;
      process.stdout.write = origStdoutWrite;
      process.exit = origExit;
    });

    it("should write reason to stderr and { decision: 'block', reason } JSON to stdout, then exit 2", () => {
      stderrChunks = [];
      stdoutChunks = [];
      process.stderr.write = ((s: string) => {
        stderrChunks.push(s);
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((s: string) => {
        stdoutChunks.push(s);
        return true;
      }) as typeof process.stdout.write;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
      }) as typeof process.exit;

      blockExit("File exceeds 400 lines");

      expect(stderrChunks.join("")).toBe("File exceeds 400 lines");
      expect(stdoutChunks.join("")).toBe(
        JSON.stringify({ decision: "block", reason: "File exceeds 400 lines" }),
      );
      expect(exitCode).toBe(2);
    });
  });

  // Claude Code's Bash tool_response is {stdout, stderr, interrupted, isImage,
  // noOutputExpected} — there is NO `output` field (verified against real
  // transcripts). PostToolUseFailure carries the text in top-level `error`.
  describe("bashOutputOf", () => {
    const base: HookInput = {
      session_id: "s",
      transcript_path: "/t",
      cwd: "/c",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
    };

    it("reads stdout from the documented Bash tool_response shape", () => {
      const out = bashOutputOf({
        ...base,
        tool_response: {
          stdout: " 12 pass\n 0 fail\n",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      });
      expect(out).toBe(" 12 pass\n 0 fail\n");
    });

    it("joins stdout and stderr, skipping empties", () => {
      expect(
        bashOutputOf({
          ...base,
          tool_response: { stdout: "out", stderr: "err", interrupted: false },
        }),
      ).toBe("out\nerr");
      expect(
        bashOutputOf({
          ...base,
          tool_response: { stdout: "", stderr: "only err", interrupted: false },
        }),
      ).toBe("only err");
    });

    it("falls back to the legacy tool_response.output field", () => {
      expect(
        bashOutputOf({ ...base, tool_response: { output: "legacy text" } }),
      ).toBe("legacy text");
    });

    it("prefers stdout/stderr over a legacy output field", () => {
      expect(
        bashOutputOf({
          ...base,
          tool_response: { stdout: "real", stderr: "", output: "legacy" },
        }),
      ).toBe("real");
    });

    it("falls back to top-level error for a PostToolUseFailure payload", () => {
      const error = "Exit code 1\nsrc/a.test.ts:\n 0 pass\n 1 fail\n";
      expect(
        bashOutputOf({
          ...base,
          hook_event_name: "PostToolUseFailure",
          tool_use_id: "toolu_01",
          error,
          is_interrupt: false,
          duration_ms: 812,
        }),
      ).toBe(error);
    });

    it("does not treat a StopFailure error type (no tool) as tool output", () => {
      const { tool_name: _t, tool_input: _i, ...noTool } = base;
      expect(
        bashOutputOf({
          ...noTool,
          hook_event_name: "StopFailure",
          error: "rate_limit",
        }),
      ).toBeUndefined();
    });

    it("returns undefined when there is no output anywhere", () => {
      expect(bashOutputOf(base)).toBeUndefined();
      expect(
        bashOutputOf({
          ...base,
          tool_response: { stdout: "", stderr: "", interrupted: false },
        }),
      ).toBeUndefined();
    });
  });
});
