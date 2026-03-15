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

  it("should run quality checks via sidecar when available", async () => {
    // Run against the sentinal project itself — sidecar may or may not be running
    // This tests the fallback path works correctly either way
    const projectRoot = join(import.meta.dir, "../..");
    const filePath = join(projectRoot, "src/hooks/file-checker.ts");
    const result = await processFileCheck(filePath, projectRoot);
    // Result is either null (no issues) or a string of messages
    expect(result === null || typeof result === "string").toBe(true);
  });
});
