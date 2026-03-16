import { describe, expect, it } from "bun:test";
import { processFileCheck } from "./file-checker";
import { join } from "node:path";

describe("file-checker hook", () => {
  it("should return null for non-TypeScript files", async () => {
    const result = await processFileCheck("/project/readme.md", "/project");
    expect(result).toBeNull();
  });
  it("should handle non-existent files gracefully", async () => {
    const result = await processFileCheck("/nonexistent/app.ts", "/tmp");
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("should perform only structural checks (no sidecar quality calls)", async () => {
    // Quality checks (tsc, eslint, prettier) are now on-demand only.
    // processFileCheck should only do instant structural checks.
    const projectRoot = join(import.meta.dir, "../..");
    const filePath = join(projectRoot, "src/hooks/file-checker.ts");
    const result = await processFileCheck(filePath, projectRoot);
    // Result is either null (no issues) or a string of structural messages
    expect(result === null || typeof result === "string").toBe(true);
    // Should NOT contain any quality check output
    if (result) {
      expect(result).not.toContain("[tsc]");
      expect(result).not.toContain("[eslint]");
      expect(result).not.toContain("[prettier]");
    }
  });
});
