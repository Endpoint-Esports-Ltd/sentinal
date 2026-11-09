/**
 * Foreign (cross-repo) children of a master plan — split from
 * `master-audit.ts` for length.
 *
 * A child whose plan carries `Repo:` changes another repo. Its plan in the
 * master's `docs/plans/` is a SEED; the live copy sits in a worktree of that
 * repo, and the coordinator records where in the seed's `Location:` (absolute
 * while the phase runs, then relative to `Repo:` after the merge). The
 * seed → `Location:` direction is the link: the copy's `Parent:` must equal
 * the master slug; its `Master:` header is informational and never checked.
 *
 * ⛔ Direct-fs, no git and no store (see `master-audit.ts`). Never scan another
 * repo's `docs/plans` by slug — only `Location:` is followed.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  loadRelatedProjects,
  relativeBase,
  type RelatedDeps,
} from "../project/related.js";
import { parsePlanFile } from "./parser.js";
import { markFencedLines } from "./parser-fences.js";
import type { Spec, SpecStatus } from "./types.js";

export type ForeignFindingKind =
  | "foreign-location-missing"
  | "foreign-link-mismatch"
  | "foreign-status-disagrees";

export interface ForeignFinding {
  kind: ForeignFindingKind;
  message: string;
}

export interface ForeignChild {
  /** The status that counts: the copy's when `Location:` is valid, else the seed's. */
  status: SpecStatus;
  rawStatus?: string;
  /** Resolved directory of the seed's `Repo:`. */
  repo: string;
  /** Resolved `Location:` file, when it exists and links back. */
  location?: string;
  findings: ForeignFinding[];
}

/** Raw `Status:` value, read before `normalizeStatus` collapses unknowns. */
export function readRawStatus(planFile: string): string | undefined {
  const lines = readFileSync(planFile, "utf-8").split("\n").slice(0, 20);
  const fenced = markFencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].trim().match(/^(?:\*\*)?Status:?(?:\*\*)?\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * The master's repo root: the nearest ancestor of the plan holding a `.git`
 * entry (file or directory — linked worktrees too). Without one, the parent of
 * `docs/plans`, else the plan's own directory.
 */
export function findMasterWorkspace(masterPlanPath: string): string {
  const planDir = dirname(resolve(masterPlanPath));
  for (let dir = planDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) break;
  }
  return basename(planDir) === "plans" && basename(dirname(planDir)) === "docs"
    ? dirname(dirname(planDir))
    : planDir;
}

/**
 * `Repo:` → directory: absolute as is; a `related.json` name; else relative to
 * the master repo's MAIN checkout (`relativeBase`), so a master audited from a
 * linked worktree nested in the repo still finds `../api`.
 */
export function resolveSeedRepo(
  repo: string,
  masterWorkspace: string,
  deps: Pick<RelatedDeps, "mainCheckout"> = {},
): string {
  if (isAbsolute(repo)) return resolve(repo);
  const named = loadRelatedProjects(masterWorkspace, {
    identity: (p) => p, // only the path is needed — no git spawn
    ...deps,
  }).projects.find((p) => p.name === repo);
  return named
    ? named.path
    : resolve(relativeBase(masterWorkspace, deps), repo);
}

/** Resolve a seed (a child plan with `Repo:`) to the status that counts. */
export function resolveForeignChild(o: {
  planFile: string;
  spec: Spec;
  masterSlug: string;
  masterWorkspace: string;
}): ForeignChild {
  const repo = resolveSeedRepo(o.spec.repo ?? "", o.masterWorkspace);
  const seedRaw = readRawStatus(o.planFile);
  const seedOnly = (findings: ForeignFinding[] = []): ForeignChild => ({
    status: o.spec.status,
    ...(seedRaw ? { rawStatus: seedRaw } : {}),
    repo,
    findings,
  });

  // Skip/Stop of a foreign phase sets the seed CANCELLED; the copy may lag.
  if (o.spec.status === "CANCELLED") return seedOnly();

  if (!o.spec.location) {
    // Not started — unless the seed claims VERIFIED, which nothing can back.
    return o.spec.status === "VERIFIED"
      ? seedOnly([
          {
            kind: "foreign-location-missing",
            message:
              `Seed reads VERIFIED but has no \`Location:\` — there is no child plan ` +
              `in ${repo} to verify it against. The coordinator records the copy's ` +
              `path in the seed when the phase starts.`,
          },
        ])
      : seedOnly();
  }

  const location = isAbsolute(o.spec.location)
    ? resolve(o.spec.location)
    : resolve(repo, o.spec.location);
  let copy: Spec;
  try {
    copy = parsePlanFile(location);
  } catch {
    const noRepo = existsSync(repo) ? "" : ` The repo ${repo} does not exist.`;
    return seedOnly([
      {
        kind: "foreign-location-missing",
        message: `\`Location: ${o.spec.location}\` does not resolve to a readable plan (${location}).${noRepo}`,
      },
    ]);
  }
  if (copy.parent !== o.masterSlug) {
    return seedOnly([
      {
        kind: "foreign-link-mismatch",
        message:
          `The plan at ${location} reads \`Parent: ${copy.parent ?? "(none)"}\`, ` +
          `not \`Parent: ${o.masterSlug}\` — it is not this master's child.`,
      },
    ]);
  }

  const raw = readRawStatus(location);
  const findings: ForeignFinding[] =
    copy.status === o.spec.status
      ? []
      : [
          {
            kind: "foreign-status-disagrees",
            message:
              `Seed reads ${o.spec.status} but the child at ${location} reads ` +
              `${copy.status}. Mirror the child's final status onto the seed.`,
          },
        ];
  return {
    status: copy.status,
    ...(raw ? { rawStatus: raw } : {}),
    repo,
    location,
    findings,
  };
}
