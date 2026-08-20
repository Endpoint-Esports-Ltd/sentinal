/**
 * Seed-source discovery (monorepo-aware).
 *
 * Finds every directory that holds a `.env.example`: the repo root plus each
 * workspace package root declared by `package.json` `workspaces` or
 * `pnpm-workspace.yaml`. Issue #2's reporter runs "a TypeScript monorepo with a
 * multi-app dev stack" — root-only discovery finds nothing at all for exactly
 * the project shape that filed the issue.
 *
 * ## ⛔ Why this walks the tree instead of globbing
 *
 * The obvious implementation globs `<pattern>/package.json` and filters
 * `node_modules` out of the results. That filters the *output* but not the
 * *traversal*: `packages/**` (legal in npm and pnpm) visits every installed
 * dependency's `package.json` in the repo — on the `worktree create` hot path
 * and on every lazy-allocation reconcile. Worse, one unreadable directory
 * anywhere under `node_modules` makes `scanSync` throw `EACCES`, which drops
 * the whole pattern and silently discovers nothing.
 *
 * So: walk from the pattern's literal prefix, prune `node_modules` and dot
 * directories, cap the depth, and use `Bun.Glob.match()` on the relative paths.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

/** The one filename treated as a seed source. */
export const SEED_FILENAME = ".env.example";

/** Never traversed: a dependency tree holds no workspace of this repo. */
const PRUNED_DIRS = new Set(["node_modules"]);

/**
 * How far below a pattern's literal prefix a `**` may reach.
 *
 * Unbounded recursion is what makes the naive glob slow; nobody nests workspace
 * packages four levels below their declared root, and the cost of being wrong
 * is one undiscovered `.env.example` (which warns) rather than a stall.
 */
const MAX_GLOB_DEPTH = 4;

// ─── Workspace declarations ─────────────────────────────────────────────────

/** Workspace globs from `package.json` — array form and `{ packages: [] }` form. */
function packageJsonWorkspaces(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, "package.json"), "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const ws = (parsed as { workspaces?: unknown } | null)?.workspaces;
  if (Array.isArray(ws)) return ws.filter((w) => typeof w === "string");
  const nested = (ws as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(nested)
    ? nested.filter((w) => typeof w === "string")
    : [];
}

/**
 * Workspace globs from `pnpm-workspace.yaml`.
 *
 * Deliberately a 15-line parser rather than a YAML dependency: the file shape is
 * fixed (`packages:` followed by a `-` list) and adding a runtime dep to hooks
 * that run on every worktree create is a poor trade.
 */
function pnpmWorkspaces(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf-8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let inPackages = false;
  for (const line of raw.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!m) {
      if (line.trim() !== "" && !line.startsWith(" ")) break;
      continue;
    }
    out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

// ─── Bounded traversal ──────────────────────────────────────────────────────

/** Leading glob-free segments of a pattern — the only place worth walking from. */
function literalPrefix(pattern: string): string {
  const out: string[] = [];
  for (const seg of pattern.split("/")) {
    if (/[*?[\]{}!()]/.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Repo-relative directories a `pattern` could possibly match, pruned and
 * depth-capped. Never throws: an unreadable directory is skipped, not fatal.
 */
function candidateDirs(repoRoot: string, pattern: string): string[] {
  const baseRel = literalPrefix(pattern);
  const wildSegments =
    pattern.split("/").length -
    (baseRel === "" ? 0 : baseRel.split("/").length);
  const maxDepth = pattern.includes("**")
    ? MAX_GLOB_DEPTH
    : Math.max(wildSegments, 0);

  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (rel !== "") out.push(rel);
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return; // unreadable — skip this branch, keep the rest of the pattern
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (PRUNED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(baseRel, 0);
  return out;
}

/** Every workspace package directory, repo-relative. */
export function workspacePackageDirs(repoRoot: string): string[] {
  const patterns = [
    ...packageJsonWorkspaces(repoRoot),
    ...pnpmWorkspaces(repoRoot),
  ]
    .filter((p) => !p.startsWith("!"))
    .map((p) => p.replace(/\/+$/, ""));

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    let glob: Bun.Glob;
    try {
      glob = new Bun.Glob(pattern);
    } catch {
      continue;
    }
    for (const rel of candidateDirs(repoRoot, pattern)) {
      if (rel === "." || !glob.match(rel)) continue;
      if (!existsSync(join(repoRoot, rel, "package.json"))) continue;
      dirs.add(rel);
    }
  }
  return [...dirs];
}

/**
 * Repo-relative directories that hold a `.env.example`: the repo root (`"."`)
 * and every workspace package root. Root first, then packages alphabetically.
 */
export function discoverSeedSources(repoRoot: string): string[] {
  const candidates = new Set<string>(["."]);
  for (const d of workspacePackageDirs(repoRoot)) candidates.add(d);

  return [...candidates]
    .filter((d) => existsSync(join(repoRoot, d, SEED_FILENAME)))
    .sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
}
