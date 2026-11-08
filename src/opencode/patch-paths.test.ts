/**
 * patchFilePaths — the files an OpenCode `apply_patch` call touches.
 */

import { describe, it, expect } from "bun:test";
import { patchFilePaths } from "./patch-paths.js";

const PATCH = `*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
*** Update File: src/old.ts
@@ class A
-  a = 1;
+  a = 2;
*** Move to: src/renamed.ts
*** Delete File: /abs/gone.ts
*** End Patch`;

describe("patchFilePaths", () => {
  it("lists Add / Update / Delete / Move-to targets, resolved against the base", () => {
    expect(patchFilePaths(PATCH, "/ws")).toEqual([
      "/ws/src/new.ts",
      "/ws/src/old.ts",
      "/ws/src/renamed.ts",
      "/abs/gone.ts",
    ]);
  });

  it("dedupes and trims, tolerating CRLF and indentation", () => {
    const p =
      "*** Update File:  src/a.ts  \r\n  *** Update File: src/a.ts\r\n*** Add File: b.ts";
    expect(patchFilePaths(p, "/ws")).toEqual(["/ws/src/a.ts", "/ws/b.ts"]);
  });

  it("ignores unknown lines and non-string input", () => {
    expect(patchFilePaths("+*** Update File: x.ts\n@@ y", "/ws")).toEqual([]);
    expect(patchFilePaths("*** Update File:   ", "/ws")).toEqual([]);
    expect(patchFilePaths(undefined, "/ws")).toEqual([]);
    expect(patchFilePaths(42 as unknown as string, "/ws")).toEqual([]);
  });
});

import { toolFilePaths } from "./patch-paths.js";

describe("toolFilePaths", () => {
  it("apply_patch / patch → the patch's targets", () => {
    const patchText = "*** Update File: src/a.ts";
    expect(toolFilePaths("apply_patch", { patchText }, "/ws")).toEqual([
      "/ws/src/a.ts",
    ]);
    expect(toolFilePaths("patch", { patchText }, "/ws")).toEqual([
      "/ws/src/a.ts",
    ]);
  });

  it("a patch tool without patchText falls back to its filePath", () => {
    expect(toolFilePaths("patch", { filePath: "/x.ts" }, "/ws")).toEqual([
      "/x.ts",
    ]);
  });

  it("other tools → filePath / file_path / path, unchanged", () => {
    expect(toolFilePaths("edit", { filePath: "/x.ts" }, "/ws")).toEqual([
      "/x.ts",
    ]);
    expect(toolFilePaths("write", { file_path: "rel.ts" }, "/ws")).toEqual([
      "rel.ts",
    ]);
    expect(toolFilePaths("read", { path: "/p" }, "/ws")).toEqual(["/p"]);
    expect(toolFilePaths("bash", { command: "ls" }, "/ws")).toEqual([]);
    expect(toolFilePaths("edit", { filePath: 3 }, "/ws")).toEqual([]);
  });
});
