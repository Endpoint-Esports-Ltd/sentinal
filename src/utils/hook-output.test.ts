import { describe, expect, it, mock, afterEach } from "bun:test";
import { deny, hint, block, denyExit } from "./hook-output";

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
});
