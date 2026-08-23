/**
 * Analysis helpers tests.
 *
 * `helpers.ts` shipped without a companion test. This covers `countImporters`,
 * which is replaced in this plan, plus the neighbours it is composed with so a
 * regression in the swap is visible.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import {
  countImporters,
  countLines,
  isExpectedFile,
  countUniqueFiles,
} from "./helpers.js";

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("countImporters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-helpers");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return 0 when nothing imports the file", () => {
    write(tmpDir, "src/lonely.ts", "export const x = 1;\n");
    expect(countImporters("src/lonely.ts", tmpDir)).toBe(0);
  });

  it("should count a direct importer", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/caller.ts", 'import { t } from "./target.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(1);
  });

  it("should count a transitive importer", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/mid.ts", 'import { t } from "./target.js";\n');
    write(tmpDir, "src/leaf.ts", 'import { m } from "./mid.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(2);
  });

  it("should not count the file itself", () => {
    write(tmpDir, "src/target.ts", 'import { x } from "./target.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(0);
  });

  it("should not count a same-named file in another directory", () => {
    // The old grep matched on basename, so `src/b/target.ts` polluted the
    // count for `src/a/target.ts`.
    write(tmpDir, "src/a/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/b/target.ts", "export const t = 2;\n");
    write(tmpDir, "src/b/caller.ts", 'import { t } from "./target.js";\n');
    expect(countImporters("src/a/target.ts", tmpDir)).toBe(0);
    expect(countImporters("src/b/target.ts", tmpDir)).toBe(1);
  });

  it("should return 0 for a file outside the scanned tree", () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    expect(countImporters("nope/missing.ts", tmpDir)).toBe(0);
  });
});

describe("countLines / isExpectedFile / countUniqueFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-helpers2");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should count lines and return 0 for a missing file", () => {
    write(tmpDir, "a.ts", "one\ntwo\nthree");
    expect(countLines(join(tmpDir, "a.ts"))).toBe(3);
    expect(countLines(join(tmpDir, "missing.ts"))).toBe(0);
  });

  it("should treat every file as expected when the spec set is empty", () => {
    expect(isExpectedFile("src/anything.ts", new Set())).toBe(true);
  });

  it("should suffix-match a changed path against the spec set", () => {
    const spec = new Set(["src/auth/auth.service.ts"]);
    expect(isExpectedFile("src/auth/auth.service.ts", spec)).toBe(true);
    expect(isExpectedFile("src/other.ts", spec)).toBe(false);
  });

  it("should count unique files across diagnostics", () => {
    expect(
      countUniqueFiles([
        { file: "a.ts", line: 1, column: 1, message: "x" },
        { file: "a.ts", line: 2, column: 1, message: "y" },
        { file: "b.ts", line: 1, column: 1, message: "z" },
      ]),
    ).toBe(2);
  });
});
