/**
 * Orca child worktrees for dispatch (D8), split from `dispatch.ts` for length;
 * `dispatch.ts` re-exports everything here.
 *
 * A child worktree is created with NO agent and `--setup skip`: Sentinal adopts
 * it and runs setup before any worker starts. With `repo`, the worktree is
 * created in ANOTHER registered repo (cross-repo master plans). Verified live
 * on Orca 1.4.253 (`sentinal-orca-cli` skill):
 *
 * - `--repo path:` is matched literally against the registered path, so the
 *   repo's realpath is passed (`/var/…` misses a repo registered as
 *   `/private/var/…`).
 * - `--no-parent` is required (and `--parent-worktree` forbidden): an omitted
 *   `--repo` would infer the coordinator's repo, and lineage across repos is
 *   meaningless.
 * - An unregistered repo answers `repo_not_found`; Sentinal reports
 *   `orca repo add --path <repo>` and never runs it (it changes the user's
 *   Orca setup).
 * - `worktree show --worktree name:<n>` is `selector_ambiguous` when another
 *   repo has a same-named worktree, so a path-less foreign create is resolved
 *   through the repo's id and `worktree list`, never a bare name lookup.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runOrca, type OrcaRunner } from "./cli.js";
import { err, pathFromId, type Failure, type Ok } from "./dispatch-core.js";
import type { OrcaWorktreeRecord, OrcaWorktreeResult } from "./types.js";

type Prepared = Ok<{
  path: string;
  worktreeId: string | null;
  branch?: string;
}>;

function recordOf(wt: OrcaWorktreeRecord | undefined) {
  const path = wt?.path ?? pathFromId(wt?.id);
  if (!path) return null;
  return {
    path,
    worktreeId: wt?.id ?? null,
    ...(wt?.branch ? { branch: wt.branch } : {}),
  };
}

function worktreeOf(result: unknown) {
  return recordOf((result as OrcaWorktreeResult | undefined)?.worktree);
}

/** The realpath of an existing directory, or a Failure. */
export function resolveRepoDir(repo: string): { dir: string } | Failure {
  if (!isAbsolute(repo)) {
    return err("invalid_repo", `repo must be an absolute path: ${repo}`);
  }
  try {
    const dir = realpathSync(repo);
    if (statSync(dir).isDirectory()) return { dir };
  } catch {
    /* fall through */
  }
  return err("invalid_repo", `repo is not an existing directory: ${repo}`);
}

/**
 * `orca worktree create --setup skip` with NO agent. Same repo: lineage under
 * the caller (`--parent-worktree <parent ?? current>`), falling back to
 * `worktree show` by name. Foreign `repo`: see the module comment.
 */
export async function prepareChildWorktree(o: {
  name: string;
  baseBranch: string;
  parent?: string;
  /** Absolute path of another repo registered in Orca. */
  repo?: string;
  runner?: OrcaRunner;
}): Promise<Prepared | Failure> {
  if (o.repo !== undefined) return prepareForeign({ ...o, repo: o.repo });
  const created = await runOrca(
    [
      "worktree",
      "create",
      "--name",
      o.name,
      "--base-branch",
      o.baseBranch,
      "--parent-worktree",
      o.parent ?? "current",
      "--setup",
      "skip",
    ],
    { runner: o.runner },
  );
  if (!created.ok) return { ok: false, error: created.error };
  const wt = worktreeOf(created.result);
  if (wt) return { ok: true, ...wt };

  const shown = await runOrca(
    ["worktree", "show", "--worktree", `name:${o.name}`],
    { runner: o.runner },
  );
  const again = shown.ok ? worktreeOf(shown.result) : null;
  if (again) return { ok: true, ...again };
  return err(
    "orca_bad_output",
    `worktree create for ${o.name} returned no path, and worktree show could not resolve it`,
  );
}

async function prepareForeign(o: {
  name: string;
  baseBranch: string;
  repo: string;
  runner?: OrcaRunner;
}): Promise<Prepared | Failure> {
  const resolved = resolveRepoDir(o.repo);
  if ("ok" in resolved) return resolved;
  const selector = `path:${resolved.dir}`;
  const created = await runOrca(
    [
      "worktree",
      "create",
      "--repo",
      selector,
      "--name",
      o.name,
      "--base-branch",
      o.baseBranch,
      "--no-parent",
      "--setup",
      "skip",
    ],
    { runner: o.runner },
  );
  if (!created.ok) {
    if (created.error.code === "repo_not_found") {
      return err(
        "repo_not_registered",
        `Orca does not know the repo ${resolved.dir}. Ask the user to register it with \`orca repo add --path ${resolved.dir}\` (Sentinal never registers repos itself), then dispatch again.`,
      );
    }
    return { ok: false, error: created.error };
  }
  const wt = worktreeOf(created.result);
  if (wt) return { ok: true, ...wt };

  const found = await findInRepo(selector, o.name, o.runner);
  if (found) return { ok: true, ...found };
  return err(
    "orca_bad_output",
    `worktree create for ${o.name} in ${resolved.dir} returned no path, and worktree list has no worktree of that repo with that name`,
  );
}

/** The `worktree list` entry with the repo's id and the display name. */
async function findInRepo(selector: string, name: string, runner?: OrcaRunner) {
  const repo = await runOrca<{ repo?: { id?: string } }>(
    ["repo", "show", "--repo", selector],
    { runner },
  );
  const repoId = repo.ok ? repo.result?.repo?.id : undefined;
  if (!repoId) return null;
  const listed = await runOrca<{ worktrees?: OrcaWorktreeRecord[] }>(
    ["worktree", "list"],
    { runner },
  );
  if (!listed.ok) return null;
  const match = (listed.result?.worktrees ?? []).find(
    (w) =>
      (w.repoId === repoId || w.id?.startsWith(`${repoId}::`)) &&
      w.displayName === name,
  );
  return recordOf(match);
}

export async function removeChildWorktree(
  path: string,
  o: { force?: boolean; runner?: OrcaRunner } = {},
): Promise<Ok<{ result: unknown }> | Failure> {
  const args = ["worktree", "rm", "--worktree", `path:${path}`];
  if (o.force) args.push("--force");
  const r = await runOrca(args, { runner: o.runner });
  return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
}
