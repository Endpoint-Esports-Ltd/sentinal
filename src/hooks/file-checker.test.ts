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

  describe("PATH_EXEMPTIONS integration", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "sentinal-fc-exemptions-"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should not produce a block/warn for targets/opencode/plugins/sentinal.ts even when very long", async () => {
      // Replicate the plugin path structure inside a temp dir
      const pluginDir = join(tmpDir, "targets", "opencode", "plugins");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(pluginDir, { recursive: true });
      const filePath = join(pluginDir, "sentinal.ts");
      // Write 1200 lines of regular TS code (no generated marker)
      const body = "export const x = 1;\n".repeat(1200);
      writeFileSync(filePath, body);

      const result = await processFileCheck(filePath, tmpDir);
      // The file-length check must NOT produce an "exceeds" message for this path
      if (result) {
        expect(result).not.toContain("limit");
        expect(result).not.toContain("soft limit");
      }
    });
  });
});

// ─── Cross-project: framework detection on the file's own checkout (Phase 1) ─

import { mkdirSync, realpathSync } from "node:fs";
import { spyOn } from "bun:test";
import * as angular from "../checkers/angular.js";
import { fileCheckForEdit } from "./file-checker";

describe("fileCheckForEdit — framework of the file's project", () => {
  let tmp: string;
  let a: string;
  let b: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "file-checker-cross-")));
    a = join(tmp, "a");
    b = join(tmp, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "src", "app"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: d });
    }
    writeFileSync(join(b, "angular.json"), "{}");
    const comp = join(b, "src", "app", "foo.component.ts");
    writeFileSync(comp, "export class Foo {}\n");
    writeFileSync(comp.replace(/\.ts$/, ".spec.ts"), "");
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("detects Angular in repo B from session A (angular.json only in B)", async () => {
    const spy = spyOn(angular, "runAngularChecks").mockImplementation(() => [
      { tool: "ng-build", severity: "error", message: "stubbed ng build" },
    ]);
    try {
      const result = await fileCheckForEdit(
        join(b, "src", "app", "foo.component.ts"),
        a,
      );
      expect(result).toContain("[Angular] stubbed ng build");
      expect(spy.mock.calls[0]![0]).toBe(b);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("a non-Angular file in another repo needs no project resolution", async () => {
    const plain = join(b, "src", "plain.ts");
    writeFileSync(plain, "export const x = 1;\n");
    writeFileSync(join(b, "src", "plain.test.ts"), "");
    expect(await fileCheckForEdit(plain, a)).toBeNull();
  });
});
