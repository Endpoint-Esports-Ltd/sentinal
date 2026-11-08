/**
 * captureProject — the storage key of an auto-captured observation
 * (cross-project scope, Phase 1).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { captureProject } from "./capture-project.js";
import type { FileProject, SessionRoots } from "./file-project.js";

let tmp: string;
let a: string;
let b: string;
let session: SessionRoots;
const seen: string[] = [];

function fakeResolve(p: string): FileProject {
  seen.push(p);
  const root = p.startsWith(b) ? b : a;
  return { identity: root, workspace: root, foreign: root === b };
}

beforeAll(() => {
  tmp = realpathSync(makeTmpDir("capture-project"));
  a = join(tmp, "a");
  b = join(tmp, "b");
  mkdirSync(a);
  mkdirSync(b);
  session = { identity: a, workspace: a };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("captureProject", () => {
  it("a file path → the file's project, with sessionProject when it differs", () => {
    expect(
      captureProject(
        { filePath: join(b, "x.ts"), cwd: a },
        session,
        fakeResolve,
      ),
    ).toEqual({ projectPath: b, sessionProject: a, foreign: true });
  });

  it("a session-repo file → the session key and no sessionProject", () => {
    expect(
      captureProject(
        { filePath: join(a, "x.ts"), cwd: a },
        session,
        fakeResolve,
      ),
    ).toEqual({ projectPath: a, foreign: false });
  });

  it("a relative file path resolves against the event cwd", () => {
    seen.length = 0;
    captureProject(
      { filePath: "x.ts", cwd: join(a, "src") },
      session,
      fakeResolve,
    );
    expect(seen).toEqual([join(a, "src", "x.ts")]);
  });

  it("a Bash command with no file → the project of its effective cwd", () => {
    expect(
      captureProject(
        { command: "cd ../b && bun test", cwd: a },
        session,
        fakeResolve,
      ),
    ).toEqual({ projectPath: b, sessionProject: a, foreign: true });
  });

  it("an unresolvable cd or no file and no command → the session key", () => {
    expect(
      captureProject({ command: "cd ~ && ls", cwd: a }, session, fakeResolve),
    ).toEqual({ projectPath: a, foreign: false });
    expect(captureProject({ cwd: a }, session, fakeResolve)).toEqual({
      projectPath: a,
      foreign: false,
    });
  });

  it("defaults the cwd to the session workspace", () => {
    seen.length = 0;
    captureProject({ command: "ls" }, session, fakeResolve);
    expect(seen).toEqual([a]);
  });
});
