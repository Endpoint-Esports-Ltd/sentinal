import { describe, expect, it } from "bun:test";
import { runTypeScriptChecks, type CheckResult } from "./typescript";

describe("typescript checker", () => {
  describe("runTypeScriptChecks", () => {
    it("should return an array", () => {
      const results = runTypeScriptChecks(
        "/nonexistent/file.ts",
        "/tmp",
        "npx",
      );
      expect(Array.isArray(results)).toBe(true);
    });

    it("should include results with tool field", () => {
      const results = runTypeScriptChecks(
        "/nonexistent/file.ts",
        "/tmp",
        "npx",
      );
      for (const r of results) {
        expect(["prettier", "eslint", "tsc"]).toContain(r.tool);
      }
    });
  });
});
