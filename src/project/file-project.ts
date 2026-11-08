/**
 * File Project — the THIRD root resolver: which project owns an edited file.
 *
 * `resolveProjectIdentity` / `resolveWorkspaceRoot` (`./identity.ts`) answer
 * "where is this SESSION". A session in an ops repo may edit files in other
 * repos, and every per-file row (observation, TDD row, conflict record) must
 * be keyed by the FILE's project so sessions in either repo agree
 * (docs/plans/2026-11-05-cross-project-scope.md).
 *
 * ⛔ Never pass a file path to `resolveProjectIdentity`: git fails with a file
 * as cwd and the fallback returns the file's own realpath as the "project".
 * This module finds the repo top on the filesystem first.
 *
 * Contract:
 *   1. Start at the path (file or directory), climb to the nearest EXISTING
 *      entry (a Write may create directories), `realpath` it.
 *   2. Climb to the nearest ancestor with a `.git` entry (file or directory —
 *      linked worktrees and submodules use a `.git` file).
 *   3. No `.git` → the session roots, `foreign: false`.
 *   4. `realpath(repoTop) === realpath(session.workspace)` → the session roots,
 *      `foreign: false`, and NO git spawn (the hot path).
 *   5. Else identity = `canonicalProjectKey(repoTop)` (one memoized spawn),
 *      workspace = repoTop, foreign = identity !== session.identity — another
 *      worktree of the same repo is not foreign, but has its own workspace.
 *   6. Never throws, never returns `""`.
 *
 * ⛔ Free of `bun:sqlite` — bundled into the OpenCode plugin.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalProjectKey } from "../sidecar/project-key.js";
import { resolveProjectIdentity, resolveWorkspaceRoot } from "./identity.js";

/** The session's two roots (see `./identity.ts`). */
export interface SessionRoots {
  /** Storage key of the session's project (main checkout). */
  identity: string;
  /** The session's local checkout root (a realpath). */
  workspace: string;
}

/** The project that owns a file. */
export interface FileProject {
  /** Storage key for per-file rows. */
  identity: string;
  /** The file's checkout root — for filesystem reads (framework, rules). */
  workspace: string;
  /** True when the file belongs to a different repository than the session. */
  foreign: boolean;
}

export interface FileProjectDeps {
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  /** Repo top → storage key. Default: memoized `resolveProjectIdentity`. */
  identity?: (repoTop: string) => string;
}

function safeRealpath(realpath: (p: string) => string, p: string): string {
  try {
    const r = realpath(p);
    return r && r.trim() !== "" ? r : p;
  } catch {
    return p;
  }
}

/** The session roots, read lazily so a getter-backed session spawns nothing extra. */
function sessionResult(session: SessionRoots): FileProject {
  return {
    get identity() {
      return session.identity;
    },
    get workspace() {
      return session.workspace;
    },
    foreign: false,
  };
}

/** Nearest ancestor (inclusive) of an existing directory holding `.git`. */
function findRepoTop(
  start: string,
  exists: (p: string) => boolean,
): string | null {
  let dir = start;
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Which project owns `filePath` (absolute, or relative to the session workspace). */
export function resolveFileProject(
  filePath: string,
  session: SessionRoots,
  deps: FileProjectDeps = {},
): FileProject {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? realpathSync;
  const toIdentity = deps.identity ?? canonicalProjectKey;
  try {
    if (typeof filePath !== "string" || filePath.trim() === "")
      return sessionResult(session);
    let p = resolve(session.workspace, filePath);
    while (!exists(p)) {
      const parent = dirname(p);
      if (parent === p) return sessionResult(session);
      p = parent;
    }
    // Starting at the entry itself is fine for a file: `<file>/.git` never exists.
    const repoTop = findRepoTop(safeRealpath(realpath, p), exists);
    if (repoTop === null) return sessionResult(session);
    if (repoTop === safeRealpath(realpath, session.workspace))
      return sessionResult(session);

    let identity = repoTop;
    try {
      const key = toIdentity(repoTop);
      if (typeof key === "string" && key.trim() !== "") identity = key;
    } catch {
      /* keep the repo top */
    }
    return {
      identity,
      workspace: repoTop,
      foreign: identity !== session.identity,
    };
  } catch {
    return sessionResult(session);
  }
}

export interface SessionRootsDeps {
  identity?: (cwd: string) => string;
  /** Fallback when no `.git` is found above the cwd. Default: `resolveWorkspaceRoot`. */
  workspace?: (cwd: string) => string;
}

/**
 * The session roots of a cwd, each resolved LAZILY on first read and then
 * memoized. Claude Code hooks are fresh processes: call this once per hook
 * invocation.
 *
 * `workspace` is found on the FILESYSTEM — the nearest ancestor of the
 * realpath'd cwd holding a `.git` entry, exactly how the resolver finds a
 * file's repo top, so the two compare like with like — and falls back to
 * `resolveWorkspaceRoot` (git) only outside any checkout. The same-repo
 * short-circuit therefore spawns no git at all (measured: the git-based
 * workspace added ~15 ms to every slow-path tdd-guard run). `identity` still
 * costs one spawn, only when something reads it (a storage key, a spec lookup).
 */
export function sessionRootsFromCwd(
  cwd: string,
  deps: SessionRootsDeps = {},
): SessionRoots {
  const toIdentity = deps.identity ?? resolveProjectIdentity;
  const toWorkspace = deps.workspace ?? resolveWorkspaceRoot;
  let identity: string | undefined;
  let workspace: string | undefined;
  return {
    get identity() {
      identity ??= toIdentity(cwd);
      return identity;
    },
    get workspace() {
      workspace ??= fsWorkspace(cwd) ?? toWorkspace(cwd);
      return workspace;
    },
  };
}

/** Nearest checkout root above an existing cwd, from the filesystem alone. */
function fsWorkspace(cwd: string): string | null {
  try {
    if (typeof cwd !== "string" || cwd.trim() === "" || !existsSync(cwd))
      return null;
    return findRepoTop(safeRealpath(realpathSync, cwd), existsSync);
  } catch {
    return null;
  }
}
