/**
 * resolveFileProject — which project owns an edited file (Phase 1 of
 * docs/plans/2026-11-05-cross-project-scope.md). Uses real temp git repos.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  resolveFileProject,
  sessionRootsFromCwd,
  type SessionRoots,
} from "./file-project.js";
import { resolveProjectIdentity } from "./identity.js";

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# t\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
}

let rawTmp: string;
let tmp: string;
let a: string;
let b: string;
let wt: string;
let outside: string;
let session: SessionRoots;

beforeAll(() => {
  // Deliberately NOT realpathed: on macOS this is /var/folders/…, a symlink
  // to /private/var/folders/… (Pre-Mortem 1).
  rawTmp = makeTmpDir("file-project");
  tmp = realpathSync(rawTmp);
  a = join(tmp, "a");
  b = join(tmp, "b");
  initRepo(a);
  initRepo(b);
  mkdirSync(join(a, "src"), { recursive: true });
  mkdirSync(join(b, "src"), { recursive: true });
  writeFileSync(join(a, "src", "x.ts"), "");
  writeFileSync(join(b, "src", "x.ts"), "");
  wt = join(tmp, "a-wt");
  Bun.spawnSync(["git", "worktree", "add", wt, "-b", "feat"], { cwd: a });
  outside = join(tmp, "plain");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "notes.ts"), "");
  session = { identity: a, workspace: a };
}, 30_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveFileProject", () => {
  it("a session-repo file → session roots, not foreign, no git spawn", () => {
    let spawns = 0;
    const r = resolveFileProject(join(a, "src", "x.ts"), session, {
      identity: (p) => {
        spawns++;
        return resolveProjectIdentity(p);
      },
    });
    expect(r).toEqual({ identity: a, workspace: a, foreign: false });
    expect(spawns).toBe(0);
  });

  it("a sibling repo's file → that repo, foreign", () => {
    const r = resolveFileProject(join(b, "src", "x.ts"), session);
    expect(r).toEqual({ identity: b, workspace: b, foreign: true });
  });

  it("a linked worktree of the session repo → same identity, own workspace, not foreign", () => {
    const r = resolveFileProject(join(wt, "README.md"), session);
    expect(r).toEqual({ identity: a, workspace: wt, foreign: false });
  }, 15_000);

  it("a submodule-style .git FILE marks its own repo", () => {
    const sub = join(a, "vendor", "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: /nowhere\n");
    const r = resolveFileProject(join(sub, "y.ts"), session, {
      identity: (p) => p,
    });
    expect(r).toEqual({ identity: sub, workspace: sub, foreign: true });
  });

  it("a file outside any repo → session roots", () => {
    const r = resolveFileProject(join(outside, "notes.ts"), session);
    expect(r).toEqual({ identity: a, workspace: a, foreign: false });
  });

  it("a new file in a not-yet-existing directory climbs to the nearest existing dir", () => {
    const r = resolveFileProject(join(b, "new", "deep", "z.ts"), session);
    expect(r).toEqual({ identity: b, workspace: b, foreign: true });
  });

  it("symlinked / non-realpath session and file paths still compare equal", () => {
    const rawA = join(rawTmp, "a");
    const link = join(tmp, "a-link");
    symlinkSync(a, link);
    let spawns = 0;
    const r = resolveFileProject(
      join(link, "src", "x.ts"),
      { identity: a, workspace: rawA },
      { identity: (p) => (spawns++, p) },
    );
    expect(r.foreign).toBe(false);
    expect(r.identity).toBe(a);
    expect(spawns).toBe(0);
  });

  it("a relative path resolves against the session workspace", () => {
    expect(resolveFileProject("src/x.ts", session).foreign).toBe(false);
    expect(resolveFileProject("../b/src/x.ts", session)).toEqual({
      identity: b,
      workspace: b,
      foreign: true,
    });
  });

  it("accepts a directory", () => {
    expect(resolveFileProject(join(b, "src"), session).identity).toBe(b);
    expect(resolveFileProject(b, session).identity).toBe(b);
  });

  it("never throws and never returns an empty key", () => {
    for (const p of ["", "   ", "/", join(tmp, "nope", "x.ts")]) {
      const r = resolveFileProject(p, session);
      expect(r.identity).not.toBe("");
      expect(r.workspace).not.toBe("");
    }
    const r = resolveFileProject(join(b, "x.ts"), session, {
      identity: () => {
        throw new Error("boom");
      },
    });
    expect(r.identity).toBe(b);
    const blank = resolveFileProject(join(b, "x.ts"), session, {
      identity: () => "",
    });
    expect(blank.identity).toBe(b);
  });
});

describe("sessionRootsFromCwd", () => {
  it("returns identity + workspace of the cwd's checkout", () => {
    const r = sessionRootsFromCwd(join(wt));
    expect(r.identity).toBe(a);
    expect(r.workspace).toBe(wt);
  }, 15_000);

  it("is lazy: resolves nothing until a root is read, then memoizes", () => {
    const calls: string[] = [];
    // `outside` has no .git: the workspace falls back to the git resolver
    const r = sessionRootsFromCwd(outside, {
      identity: (c) => (calls.push("id"), c),
      workspace: (c) => (calls.push("ws"), c),
    });
    expect(calls).toEqual([]);
    expect(r.workspace).toBe(outside);
    expect(r.workspace).toBe(outside);
    expect(calls).toEqual(["ws"]);
    expect(r.identity).toBe(outside);
    expect(r.identity).toBe(outside);
    expect(calls).toEqual(["ws", "id"]);
  });

  it("finds the workspace on the filesystem (no git spawn) inside a checkout", () => {
    const calls: string[] = [];
    const sub = join(wt, "deep");
    mkdirSync(sub, { recursive: true });
    for (const cwd of [a, join(a, "src"), sub, join(rawTmp, "a", "src")]) {
      const r = sessionRootsFromCwd(cwd, {
        workspace: (c) => (calls.push("ws"), c),
      });
      expect(r.workspace).toBe(cwd === sub ? wt : a);
    }
    expect(calls).toEqual([]);
  });

  it("the same-repo short-circuit spawns no git at all", () => {
    const calls: string[] = [];
    const roots = sessionRootsFromCwd(a, {
      identity: (c) => (calls.push("id"), c),
      workspace: (c) => (calls.push("ws"), c),
    });
    const r = resolveFileProject(join(a, "src", "x.ts"), roots);
    expect(r.foreign).toBe(false);
    expect(r.workspace).toBe(a);
    expect(calls).toEqual([]);
    expect(r.identity).toBe(a);
    expect(calls).toEqual(["id"]);
  });
});
