import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { processFileCheck } from "./file-checker";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

  describe("generated file exemption", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "sentinal-file-checker-"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should not warn about length for auto-generated files over 600 lines", async () => {
      const filePath = join(tmpDir, "generated-huge.ts");
      // Create a file with an AUTO-GENERATED header that is 800 lines long
      const header = `/**
 * Embedded Assets — AUTO-GENERATED, DO NOT EDIT
 */
`;
      const body = "export const x = 1;\n".repeat(800);
      writeFileSync(filePath, header + body);

      const result = await processFileCheck(filePath, tmpDir);
      // Should NOT mention file length since the file is exempt
      if (result) {
        expect(result).not.toContain("limit");
        expect(result).not.toContain("soft limit");
      }
    });

    it("should still warn about length for hand-written files over 400 lines", async () => {
      const filePath = join(tmpDir, "handwritten-huge.ts");
      // Regular file without any generated marker, 450 lines
      // Note: .split("\n") produces N+1 elements for N newlines, hence "451 lines"
      const body = "export const line = 1;\n".repeat(450);
      writeFileSync(filePath, body);

      const result = await processFileCheck(filePath, tmpDir);
      expect(result).not.toBeNull();
      expect(result!).toContain("soft limit");
    });
  });
});
