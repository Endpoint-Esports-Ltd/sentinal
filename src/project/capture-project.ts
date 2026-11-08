/**
 * The storage key of an auto-captured observation (cross-project scope,
 * Phase 1): the edited file's project; for a command with no file, the
 * project of the directory it ran in (after `cd`); else the session's.
 *
 * `sessionProject` is set only when the key differs from the session's, so a
 * same-repo payload stays byte-identical to what it was before.
 *
 * ⛔ Free of `bun:sqlite` — bundled into the OpenCode plugin.
 */

import { resolve as resolvePath } from "node:path";
import { effectiveCwd } from "../utils/test-run-scope.js";
import {
  resolveFileProject,
  type FileProject,
  type SessionRoots,
} from "./file-project.js";

export interface CaptureEvent {
  filePath?: string;
  /** Shell command (Bash) — its `cd` segments move the effective cwd. */
  command?: string;
  /** Directory the tool ran in; default the session workspace. */
  cwd?: string;
}

export interface CaptureProject {
  projectPath: string;
  /** The session identity, present only when it differs from `projectPath`. */
  sessionProject?: string;
  foreign: boolean;
}

type Resolve = (path: string, session: SessionRoots) => FileProject;

export function captureProject(
  event: CaptureEvent,
  session: SessionRoots,
  resolve: Resolve = resolveFileProject,
): CaptureProject {
  const cwd = event.cwd ?? session.workspace;
  let target: string | null;
  if (typeof event.filePath === "string" && event.filePath.trim() !== "")
    target = resolvePath(cwd, event.filePath);
  else if (typeof event.command === "string" && event.command.trim() !== "")
    target = effectiveCwd(event.command, cwd);
  else target = cwd;

  if (target === null) return { projectPath: session.identity, foreign: false };
  const p = resolve(target, session);
  return p.identity === session.identity
    ? { projectPath: p.identity, foreign: p.foreign }
    : {
        projectPath: p.identity,
        sessionProject: session.identity,
        foreign: p.foreign,
      };
}
