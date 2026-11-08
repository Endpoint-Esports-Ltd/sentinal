/**
 * Split one test run into per-project scopes (cross-project scope, Phase 1).
 *
 * TDD rows are keyed by the FILE's project, so a run's bulk transition must
 * be applied per project: every named test file/dir goes to the project that
 * owns it, and a run naming none is project-wide for the project of the
 * directory it RAN IN (`TestRunScope.cwd` — the `cd` target), not the
 * session's.
 *
 * ⛔ Free of `bun:sqlite` — bundled into the OpenCode plugin.
 */

import type { TestRunScope, TestScopeInput } from "../utils/test-run-scope.js";
import {
  resolveFileProject,
  type FileProject,
  type SessionRoots,
} from "./file-project.js";

export interface ProjectTestScope {
  identity: string;
  workspace: string;
  foreign: boolean;
  /** Wire scope for this project; `{}` = project-wide. */
  scope: TestScopeInput;
  /** Only some tests of the files ran — never confirm GREEN. */
  nameFiltered: boolean;
}

type Resolve = (path: string, session: SessionRoots) => FileProject;

/** One group per project the run touched, in first-seen order. */
export function groupTestScopeByProject(
  run: TestRunScope,
  session: SessionRoots,
  resolve: Resolve = resolveFileProject,
): ProjectTestScope[] {
  const { nameFiltered } = run;
  if (run.files === null) {
    const p = resolve(run.cwd ?? session.workspace, session);
    return [
      {
        identity: p.identity,
        workspace: p.workspace,
        foreign: p.foreign,
        scope: {},
        nameFiltered,
      },
    ];
  }
  const groups = new Map<
    string,
    { project: FileProject; files: string[]; dirs: string[] }
  >();
  const add = (path: string, kind: "files" | "dirs"): void => {
    const project = resolve(path, session);
    let g = groups.get(project.identity);
    if (!g) {
      g = { project, files: [], dirs: [] };
      groups.set(project.identity, g);
    }
    g[kind].push(path);
  };
  for (const f of run.files) add(f, "files");
  for (const d of run.dirs) add(d, "dirs");
  return [...groups.values()].map(({ project, files, dirs }) => ({
    identity: project.identity,
    workspace: project.workspace,
    foreign: project.foreign,
    scope: { testFiles: files, testDirs: dirs },
    nameFiltered,
  }));
}
