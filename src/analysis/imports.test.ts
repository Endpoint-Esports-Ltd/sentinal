/**
 * Parsed-import resolution tests.
 *
 * The resolver is promoted from `src/runtime/no-module-cycle.test.ts:28-71`,
 * where it had already been proven; these tests pin the additions it needed to
 * become a reach oracle — re-export exclusion, comment stripping, and
 * transitive traversal.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import {
  parseImports,
  buildImportGraph,
  transitiveImporters,
  moduleId,
} from "./imports.js";

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("parseImports", () => {
  it("should extract static import specifiers", () => {
    const specs = parseImports('import { a } from "./a.js";\n');
    expect(specs).toEqual([{ specifier: "./a.js", kind: "import" }]);
  });

  it("should extract require() and dynamic import() — which the grep never did", () => {
    const specs = parseImports(
      'const a = require("./a.js");\nconst b = await import("./b.js");\n',
    );
    expect(specs.map((s) => s.specifier).sort()).toEqual(["./a.js", "./b.js"]);
    expect(specs.every((s) => s.kind === "import")).toBe(true);
  });

  it("should classify `export ... from` as a re-export, not an import", () => {
    const specs = parseImports(
      'export * from "./star.js";\nexport { a } from "./named.js";\nexport type { T } from "./type.js";\n',
    );
    expect(specs).toHaveLength(3);
    expect(specs.every((s) => s.kind === "reexport")).toBe(true);
  });

  it("should ignore specifiers that appear only inside comments", () => {
    const specs = parseImports(
      '// import { ghost } from "./ghost.js";\n' +
        '/* import { phantom } from "./phantom.js"; */\n' +
        'import { real } from "./real.js";\n',
    );
    expect(specs).toEqual([{ specifier: "./real.js", kind: "import" }]);
  });

  it("should handle multi-line import blocks", () => {
    const specs = parseImports('import {\n  a,\n  b,\n} from "./ab.js";\n');
    expect(specs).toEqual([{ specifier: "./ab.js", kind: "import" }]);
  });
});

describe("buildImportGraph + transitiveImporters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-imports");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should resolve a relative specifier against the importing file's directory", () => {
    write(tmpDir, "src/a/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/b/caller.ts", 'import { t } from "../a/target.js";\n');

    const graph = buildImportGraph(tmpDir);
    const reach = transitiveImporters(
      graph,
      moduleId(join(tmpDir, "src/a/target.ts")),
    );

    expect([...reach]).toEqual([moduleId(join(tmpDir, "src/b/caller.ts"))]);
  });

  it("should not create an importer edge for a barrel re-export", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/index.ts", 'export * from "./target.js";\n');

    const graph = buildImportGraph(tmpDir);
    const reach = transitiveImporters(
      graph,
      moduleId(join(tmpDir, "src/target.ts")),
    );

    expect(reach.size).toBe(0);
  });

  it("should traverse transitively through an intermediate module", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/mid.ts", 'import { t } from "./target.js";\n');
    write(tmpDir, "src/leaf.ts", 'import { m } from "./mid.js";\n');

    const graph = buildImportGraph(tmpDir);
    const reach = transitiveImporters(
      graph,
      moduleId(join(tmpDir, "src/target.ts")),
    );

    expect(reach.size).toBe(2);
    expect(reach.has(moduleId(join(tmpDir, "src/leaf.ts")))).toBe(true);
  });

  it("should resolve a directory specifier to its index file", () => {
    write(tmpDir, "src/mod/index.ts", "export const m = 1;\n");
    write(tmpDir, "src/caller.ts", 'import { m } from "./mod/index.js";\n');
    write(tmpDir, "src/caller2.ts", 'import { m } from "./mod";\n');

    const graph = buildImportGraph(tmpDir);
    const reach = transitiveImporters(
      graph,
      moduleId(join(tmpDir, "src/mod/index.ts")),
    );

    expect(reach.size).toBe(2);
  });

  it("should terminate on an import cycle rather than looping forever", () => {
    write(tmpDir, "src/a.ts", 'import { b } from "./b.js";\n');
    write(tmpDir, "src/b.ts", 'import { a } from "./a.js";\n');

    const graph = buildImportGraph(tmpDir);
    const reach = transitiveImporters(
      graph,
      moduleId(join(tmpDir, "src/a.ts")),
    );

    // b imports a; a imports b. `a` must not appear in its own reach set.
    expect([...reach]).toEqual([moduleId(join(tmpDir, "src/b.ts"))]);
  });

  it("should ignore bare (package) specifiers", () => {
    write(tmpDir, "src/a.ts", 'import { z } from "zod";\n');

    const graph = buildImportGraph(tmpDir);
    expect(graph.importers.has("zod")).toBe(false);
  });
});
