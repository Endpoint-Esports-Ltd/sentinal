import { describe, expect, it } from "bun:test";
import { deny, hint, block } from "./hook-output";

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
