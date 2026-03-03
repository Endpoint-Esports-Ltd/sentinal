import { describe, expect, it } from "bun:test";
import { processFileCheck } from "./file-checker";

describe("file-checker hook", () => {
  it("should return null for non-TypeScript files", async () => {
    const result = await processFileCheck("/project/readme.md", "/project");
    expect(result).toBeNull();
  });
  it("should handle non-existent files gracefully", async () => {
    const result = await processFileCheck("/nonexistent/app.ts", "/tmp");
    expect(result === null || typeof result === "string").toBe(true);
  });
});
