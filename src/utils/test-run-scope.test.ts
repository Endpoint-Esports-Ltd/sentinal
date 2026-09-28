/**
 * testRunScope / rowMatchesTestScope — which TDD rows a test run covers (D1/D2
 * of docs/plans/2026-09-28-deferred-items.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  testRunScope,
  rowMatchesTestScope,
  isScoped,
  filterRowsByTestScope,
  toTestScopeInput,
} from "./test-run-scope.js";

let root: string;

beforeAll(() => {
  root = makeTmpDir("test-run-scope");
  mkdirSync(join(root, "src", "x"), { recursive: true });
  mkdirSync(join(root, "sub", "src"), { recursive: true });
  mkdirSync(join(root, "src", "sidecar"), { recursive: true });
  // Test-file arguments count only when the file exists (review finding).
  for (const f of [
    "src/a.test.ts",
    "src/a.spec.ts",
    "src/b.spec.ts",
    "x.test.ts",
    "sub/src/x.test.ts",
    "src/sidecar/tdd-routes.test.ts",
  ])
    writeFileSync(join(root, f), "");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const scope = (command: string, cwd = root) => testRunScope({ command, cwd });

describe("testRunScope — command parsing (D2)", () => {
  it("bun test <file> → that file, absolute", () => {
    expect(scope("bun test src/a.test.ts")).toEqual({
      files: [join(root, "src/a.test.ts")],
      dirs: [],
      nameFiltered: false,
    });
  });

  it("several files and an absolute path", () => {
    const abs = join(root, "src/b.spec.ts");
    expect(scope(`bun test ./src/a.test.ts ${abs}`).files).toEqual([
      join(root, "src/a.test.ts"),
      abs,
    ]);
  });

  it("an existing directory → dirs", () => {
    expect(scope("bun test src/x/")).toEqual({
      files: [],
      dirs: [join(root, "src/x")],
      nameFiltered: false,
    });
  });

  it("bun test with no positional args → project-wide (files null)", () => {
    expect(scope("bun test")).toEqual({
      files: null,
      dirs: [],
      nameFiltered: false,
    });
    expect(scope("bun test --timeout 30000").files).toBeNull();
  });

  it("-t / --test-name-pattern / --grep set nameFiltered and keep the files", () => {
    const r = scope("bun test -t 'my name' src/a.test.ts");
    expect(r.nameFiltered).toBe(true);
    expect(r.files).toEqual([join(root, "src/a.test.ts")]);
    expect(scope("bun test --test-name-pattern=foo").nameFiltered).toBe(true);
    expect(scope("npx mocha --grep foo x.test.js").nameFiltered).toBe(false); // not a known runner
    expect(scope("npx vitest run --grep foo a.test.ts").nameFiltered).toBe(
      true,
    );
    expect(scope("bun test src/a.test.ts").nameFiltered).toBe(false);
  });

  it("a substring filter (non-file, non-dir arg) → unknown → files null", () => {
    expect(scope("bun test foo")).toEqual({
      files: null,
      dirs: [],
      nameFiltered: false,
    });
    expect(scope("bun test src/a.test.ts foo").files).toBeNull();
  });

  it("vitest / jest / npm / pnpm / yarn wrappers", () => {
    const a = join(root, "src/a.spec.ts");
    expect(scope("npx vitest run src/a.spec.ts").files).toEqual([a]);
    expect(scope("bunx vitest src/a.spec.ts").files).toEqual([a]);
    expect(scope("vitest run src/a.spec.ts").files).toEqual([a]);
    expect(scope("npx jest src/a.spec.ts").files).toEqual([a]);
    expect(scope("npm test -- src/a.spec.ts").files).toEqual([a]);
    expect(scope("npm run test -- src/a.spec.ts").files).toEqual([a]);
    expect(scope("pnpm test src/a.spec.ts").files).toEqual([a]);
    expect(scope("pnpm exec vitest run src/a.spec.ts").files).toEqual([a]);
    expect(scope("yarn test src/a.spec.ts").files).toEqual([a]);
    expect(scope("bun run test src/a.spec.ts").files).toEqual([a]);
    expect(scope("npx jest src/x").dirs).toEqual([join(root, "src/x")]);
    expect(scope("npm test").files).toBeNull();
  });

  it("a bare test filename that does not exist at cwd (bun's substring filter) → project-wide", () => {
    // `bun test tdd-routes.test.ts` from the repo root runs
    // src/sidecar/tdd-routes.test.ts: the arg is a filter, not a path. A
    // non-existent path would scope the run to nothing and match no row.
    expect(scope("bun test tdd-routes.test.ts").files).toBeNull();
    expect(scope("bun test src/missing.test.ts").files).toBeNull();
    // Mixed: one real file + one filter → still project-wide (never narrower).
    expect(scope("bun test src/a.test.ts nope.test.ts").files).toBeNull();
  });

  it("an unresolvable cd target (-, ~, $VAR) → project-wide", () => {
    for (const c of [
      "cd - && bun test src/a.test.ts",
      "cd ~/x && bun test src/a.test.ts",
      "cd $DIR && bun test src/a.test.ts",
    ])
      expect(scope(c).files).toBeNull();
  });

  it("cd x && … resolves against the cd target", () => {
    expect(scope("cd sub && bun test src/x.test.ts").files).toEqual([
      join(root, "sub/src/x.test.ts"),
    ]);
    expect(scope(`cd ${join(root, "sub")} && bun test src`).dirs).toEqual([
      join(root, "sub/src"),
    ]);
  });

  it("env prefixes, redirections and pipes are ignored", () => {
    const f = [join(root, "x.test.ts")];
    expect(scope("FOO=1 BAR=2 bun test x.test.ts").files).toEqual(f);
    expect(scope("env FOO=1 bun test x.test.ts").files).toEqual(f);
    expect(scope("bun test x.test.ts 2>&1 | tail -20").files).toEqual(f);
    expect(scope("bun test x.test.ts > out.txt").files).toEqual(f);
    // a test run on the RIGHT of a pipe is still the test run
    expect(scope("echo hi | bun test x.test.ts").files).toEqual(f);
  });

  it("non-test commands → files null (project-wide, today's behaviour)", () => {
    for (const c of ["ls -la", "git status", "cat log.txt", "", "   "]) {
      expect(scope(c)).toEqual({ files: null, dirs: [], nameFiltered: false });
    }
  });

  it("never returns an empty scope", () => {
    for (const c of ["bun test", "bun test nope", "npm test --", "jest"]) {
      const r = scope(c);
      expect(r.files === null || r.files.length + r.dirs.length > 0).toBe(true);
    }
  });

  it("toTestScopeInput: project-wide → {}, else the files and dirs", () => {
    expect(toTestScopeInput(scope("bun test"))).toEqual({});
    expect(toTestScopeInput(scope("bun test src/a.test.ts src/x"))).toEqual({
      testFiles: [join(root, "src/a.test.ts")],
      testDirs: [join(root, "src/x")],
    });
  });

  it("isScoped: null or empty → false", () => {
    expect(isScoped({})).toBe(false);
    expect(isScoped({ testFiles: [], testDirs: [] })).toBe(false);
    expect(isScoped({ testFiles: ["/a.test.ts"] })).toBe(true);
    expect(isScoped({ testDirs: ["/src"] })).toBe(true);
  });
});

describe("rowMatchesTestScope — matching (D1)", () => {
  const P = "/p";

  it("companion x.test.ts ↔ x.ts via expected paths (no test_file_path)", () => {
    const row = { filePath: `${P}/src/x.ts` };
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/src/x.test.ts`] }),
    ).toBe(true);
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/src/x.spec.ts`] }),
    ).toBe(true);
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/src/y.test.ts`] }),
    ).toBe(false);
  });

  it("explicit test_file_path matches exactly", () => {
    const row = {
      filePath: `${P}/lib/odd.ts`,
      testFilePath: `${P}/spec/anything.test.ts`,
    };
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/spec/anything.test.ts`] }),
    ).toBe(true);
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/spec/other.test.ts`] }),
    ).toBe(false);
  });

  it("__tests__/ layout via reverse mapping", () => {
    const row = { filePath: `${P}/src/x.ts` };
    expect(
      rowMatchesTestScope(row, { testFiles: [`${P}/src/__tests__/x.test.ts`] }),
    ).toBe(true);
  });

  it("tests/ layout via reverse mapping (sibling of src/ or root)", () => {
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/src/x.ts` },
        { testFiles: [`${P}/tests/x.test.ts`] },
      ),
    ).toBe(true);
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/x.ts` },
        { testFiles: [`${P}/tests/x.test.ts`] },
      ),
    ).toBe(true);
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/src/y.ts` },
        { testFiles: [`${P}/tests/x.test.ts`] },
      ),
    ).toBe(false);
  });

  it("dir prefix: test_file_path or expected test under a dir", () => {
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/src/x/a.ts` },
        { testDirs: [`${P}/src/x`] },
      ),
    ).toBe(true);
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/src/a.ts`, testFilePath: `${P}/tests/a.test.ts` },
        { testDirs: [`${P}/tests`] },
      ),
    ).toBe(true);
    // a sibling directory sharing a prefix is NOT inside
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/src/xy/a.ts` },
        { testDirs: [`${P}/src/x`] },
      ),
    ).toBe(false);
  });

  it("unscoped (empty) → every row matches", () => {
    expect(rowMatchesTestScope({ filePath: `${P}/a.ts` }, {})).toBe(true);
    expect(
      rowMatchesTestScope(
        { filePath: `${P}/a.ts` },
        { testFiles: [], testDirs: [] },
      ),
    ).toBe(true);
  });

  it("filterRowsByTestScope keeps only covered rows", () => {
    const rows = [{ filePath: `${P}/src/a.ts` }, { filePath: `${P}/src/b.ts` }];
    expect(
      filterRowsByTestScope(rows, { testFiles: [`${P}/src/b.test.ts`] }),
    ).toEqual([{ filePath: `${P}/src/b.ts` }]);
    expect(filterRowsByTestScope(rows, {})).toEqual(rows);
  });
});
