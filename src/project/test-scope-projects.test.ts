/**
 * groupTestScopeByProject — split one test run into per-project scopes
 * (Phase 1 of docs/plans/2026-11-05-cross-project-scope.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { groupTestScopeByProject } from "./test-scope-projects.js";
import { testRunScope } from "../utils/test-run-scope.js";
import type { FileProject, SessionRoots } from "./file-project.js";

let tmp: string;
let a: string;
let b: string;
let session: SessionRoots;

/** Fake resolver: the top-level dir under tmp is the project. */
function fakeResolve(p: string): FileProject {
  const rel = p.slice(tmp.length + 1).split("/")[0];
  const root = join(tmp, rel);
  return { identity: root, workspace: root, foreign: root !== a };
}

beforeAll(() => {
  tmp = realpathSync(makeTmpDir("scope-projects"));
  a = join(tmp, "a");
  b = join(tmp, "b");
  for (const d of [join(a, "src"), join(b, "src"), join(b, "lib")])
    mkdirSync(d, { recursive: true });
  for (const f of [join(a, "src/x.test.ts"), join(b, "src/y.test.ts")])
    writeFileSync(f, "");
  session = { identity: a, workspace: a };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("groupTestScopeByProject", () => {
  it("a run naming files in two projects → one group per project", () => {
    const run = testRunScope({
      command: "bun test src/x.test.ts ../b/src/y.test.ts ../b/lib",
      cwd: a,
    });
    const groups = groupTestScopeByProject(run, session, fakeResolve);
    expect(groups).toEqual([
      {
        identity: a,
        workspace: a,
        foreign: false,
        nameFiltered: false,
        scope: { testFiles: [join(a, "src/x.test.ts")], testDirs: [] },
      },
      {
        identity: b,
        workspace: b,
        foreign: true,
        nameFiltered: false,
        scope: {
          testFiles: [join(b, "src/y.test.ts")],
          testDirs: [join(b, "lib")],
        },
      },
    ]);
  });

  it("a project-wide run → one unscoped group for the effective cwd's project", () => {
    const run = testRunScope({ command: "cd ../b && bun test", cwd: a });
    const groups = groupTestScopeByProject(run, session, fakeResolve);
    expect(groups).toEqual([
      {
        identity: b,
        workspace: b,
        foreign: true,
        nameFiltered: false,
        scope: {},
      },
    ]);
  });

  it("cd ../b && bun test src/y.test.ts → B only", () => {
    const run = testRunScope({
      command: "cd ../b && bun test src/y.test.ts",
      cwd: a,
    });
    const groups = groupTestScopeByProject(run, session, fakeResolve);
    expect(groups.map((g) => g.identity)).toEqual([b]);
    expect(groups[0].scope.testFiles).toEqual([join(b, "src/y.test.ts")]);
  });

  it("preserves nameFiltered on every group", () => {
    const run = testRunScope({
      command: "bun test src/x.test.ts ../b/src/y.test.ts -t foo",
      cwd: a,
    });
    const groups = groupTestScopeByProject(run, session, fakeResolve);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.nameFiltered)).toBe(true);
  });

  it("a project-wide scope without cwd falls back to the session workspace", () => {
    const groups = groupTestScopeByProject(
      { files: null, dirs: [], nameFiltered: false },
      session,
      fakeResolve,
    );
    expect(groups.map((g) => g.identity)).toEqual([a]);
  });

  it("uses the real resolver by default", () => {
    const groups = groupTestScopeByProject(
      { files: null, dirs: [], nameFiltered: false, cwd: a },
      session,
    );
    expect(groups[0].identity).toBe(a);
    expect(groups[0].foreign).toBe(false);
  });
});
