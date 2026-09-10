/**
 * Hiding Sentinal-written files from git inside a linked worktree.
 *
 * ## Why this module exists at all
 *
 * A linked worktree's `.git` is a *file* (`gitdir: …/.git/worktrees/<name>`),
 * and git routes `info/` through the **common dir**. The Task 1 spike
 * (`worktree-exclude.test.ts`) proved both halves of the obvious candidate wrong:
 *
 * - `git rev-parse --git-path info/exclude` resolves into the **main checkout's**
 *   `.git/info/exclude` — writing there dirties the developer's own repo.
 * - Writing to `<per-worktree gitdir>/info/exclude` avoids the leak but git
 *   **never reads it**.
 *
 * The selected mechanism is a **self-ignoring worktree-local `.gitignore`**:
 * zero common-dir writes, `git status` clean inside the worktree.
 *
 * ## The tiers, in order
 *
 * 1. **Inherited** — `git check-ignore` already covers the path (the repo's
 *    committed `.gitignore` lists `.env`, say). Write **nothing**.
 * 2. **Worktree-local `.gitignore`** — the governing ignore file is untracked or
 *    absent. Create/append, and make it list **itself** (`/.gitignore`) so it
 *    does not become an untracked file of its own.
 * 3. **Refuse** — the governing ignore file is **tracked**. Appending would hide
 *    the target but leave `M .gitignore`, which `git add -A` sweeps into a
 *    commit. Sentinal never silently dirties a tracked file: it reports the path
 *    as un-excluded and names the one-line remedy.
 *
 * The governing ignore file is the one in the **path's own directory**, so
 * `.sentinal/worktree.env` is handled by `.sentinal/.gitignore` and never
 * touches the root `.gitignore`. That is what makes Sentinal-owned files
 * excludable even in a project whose root `.gitignore` is tracked (tier 3).
 *
 * ### Residual limitation — state it plainly
 *
 * A project with a **tracked root `.gitignore` that does not cover `.env`**
 * gets a seeded `.env` visible to `git status`. That is by design: it is
 * strictly better than the status quo (an agent copying the root `.env` in,
 * equally visible, but pointing at live credentials).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Which tier actually did the work. See the module docblock. */
export type ExcludeMechanism =
  /** Tier 1 — already covered; nothing was written. */
  | "inherited"
  /** Tier 2 — a worktree-local self-ignoring `.gitignore` was created/appended. */
  | "worktree-gitignore"
  /** Tier 3 (or not a repo) — nothing could be excluded without harm. */
  | "none";

export interface ExcludeResult {
  /** Paths git will not see. */
  excluded: string[];
  /** Paths that remain **visible** to `git status`. Never silently empty. */
  unexcluded: string[];
  /** The highest tier reached across all paths. */
  mechanism: ExcludeMechanism;
  /** Human/LLM-facing, actionable. One per un-excludable path. */
  warnings: string[];
}

// ─── git primitives ─────────────────────────────────────────────────────────

function gitCode(args: string[], cwd: string): number {
  try {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode ?? 1;
  } catch {
    return 1;
  }
}

/** True when `rel` is ignored inside `cwd`. Exit 0 from `check-ignore -q`. */
export function isIgnored(cwd: string, rel: string): boolean {
  return gitCode(["check-ignore", "-q", "--", rel], cwd) === 0;
}

/**
 * True when `rel` is tracked in **this worktree's** index.
 *
 * The index is per-worktree, so this is correctly scoped: a file tracked in the
 * main checkout but not in this worktree's HEAD is reported honestly.
 */
export function isTracked(cwd: string, rel: string): boolean {
  return gitCode(["ls-files", "--error-unmatch", "--", rel], cwd) === 0;
}

/** True when `cwd` is inside a git work tree (not a bare repo, not no repo). */
function isInsideWorkTree(cwd: string): boolean {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return (r.exitCode ?? 1) === 0 && r.stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

// ─── Path helpers ───────────────────────────────────────────────────────────

/** `"./.env"` / `"/.env"` → `".env"`. Keeps forward slashes (git's own form). */
function normalizeRel(rel: string): string {
  return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** The `.gitignore` that governs `rel`, as a worktree-relative path. */
function governingIgnoreFile(rel: string): string {
  const dir = dirname(rel);
  return dir === "." || dir === "" ? ".gitignore" : `${dir}/.gitignore`;
}

// ─── Writing ────────────────────────────────────────────────────────────────

const HEADER =
  "# Written by Sentinal for this worktree only. Self-ignoring: not part of the repo.\n";

/**
 * Append any of `entries` not already present, creating the file if needed.
 * Idempotent by exact-line match.
 *
 * @throws on I/O failure — the caller downgrades that to an un-excluded path
 *   rather than failing worktree creation over an ignore file.
 */
function appendEntries(
  worktreePath: string,
  ignoreRel: string,
  entries: string[],
): void {
  const abs = join(worktreePath, ignoreRel);
  const existed = existsSync(abs);
  const current = existed ? readFileSync(abs, "utf-8") : "";
  const present = new Set(
    current
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return;

  let next = existed ? current : HEADER;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  next += missing.join("\n") + "\n";

  if (!existed) mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next);
}

// ─── Warnings ───────────────────────────────────────────────────────────────

/**
 * Tier 3. Names the risk and the remedy — a bare "could not exclude" is what
 * lets a credential-bearing file drift into a commit unnoticed.
 */
function trackedIgnoreWarning(rel: string, ignoreRel: string): string {
  return (
    `Could not hide ${rel} from git: ${ignoreRel} is TRACKED, and Sentinal will not modify a ` +
    `tracked file (that would leave "M ${ignoreRel}" for \`git add -A\` to sweep into a commit). ` +
    `${rel} is therefore VISIBLE to \`git status\` in this worktree — review before committing, ` +
    `it may hold credentials. Remedy: add "${rel}" to ${ignoreRel} and commit that one line.`
  );
}

function notARepoWarning(worktreePath: string, rels: string[]): string {
  return (
    `Could not hide ${rels.join(", ")} from git: ${worktreePath} is not inside a git work tree. ` +
    `Nothing was written. If this path should be a worktree, the checkout is broken.`
  );
}

function writeFailedWarning(
  rel: string,
  ignoreRel: string,
  err: unknown,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `Could not hide ${rel} from git: writing ${ignoreRel} failed (${detail}). ` +
    `${rel} is VISIBLE to \`git status\` — review before committing.`
  );
}

function stillVisibleWarning(rel: string, ignoreRel: string): string {
  return (
    `Wrote ${ignoreRel} but git still reports ${rel} as not ignored — it may already be tracked ` +
    `in this worktree's index. ${rel} is VISIBLE to \`git status\`; review before committing.`
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Hide `relPaths` (worktree-relative, forward-slashed) from git **inside**
 * `worktreePath`, without ever writing to the repository's common dir.
 *
 * Never throws: an un-excludable path is reported in `unexcluded` with a
 * warning, because failing to hide a file must not fail worktree creation.
 */
export function excludeFromGit(
  worktreePath: string,
  relPaths: string[],
): ExcludeResult {
  const excluded: string[] = [];
  const unexcluded: string[] = [];
  const warnings: string[] = [];

  if (relPaths.length === 0) {
    return { excluded, unexcluded, mechanism: "none", warnings };
  }

  if (!isInsideWorkTree(worktreePath)) {
    return {
      excluded: [],
      unexcluded: [...relPaths],
      mechanism: "none",
      warnings: [notARepoWarning(worktreePath, relPaths)],
    };
  }

  let wrote = false;

  for (const original of relPaths) {
    const rel = normalizeRel(original);

    // ── Tier 1: already covered. Write nothing. ──────────────────────────
    if (isIgnored(worktreePath, rel)) {
      excluded.push(original);
      continue;
    }

    const ignoreRel = governingIgnoreFile(rel);

    // ── Tier 3: refuse to dirty a tracked ignore file. ───────────────────
    if (isTracked(worktreePath, ignoreRel)) {
      unexcluded.push(original);
      warnings.push(trackedIgnoreWarning(rel, ignoreRel));
      continue;
    }

    // ── Tier 2: create/append a self-ignoring worktree-local .gitignore. ──
    try {
      appendEntries(worktreePath, ignoreRel, [
        "/.gitignore",
        `/${basename(rel)}`,
      ]);
      wrote = true;
    } catch (err) {
      unexcluded.push(original);
      warnings.push(writeFailedWarning(rel, ignoreRel, err));
      continue;
    }

    // Verify rather than assume — the file could be tracked in this index.
    if (isIgnored(worktreePath, rel)) {
      excluded.push(original);
    } else {
      unexcluded.push(original);
      warnings.push(stillVisibleWarning(rel, ignoreRel));
    }
  }

  const mechanism: ExcludeMechanism = wrote
    ? "worktree-gitignore"
    : excluded.length > 0
      ? "inherited"
      : "none";

  return { excluded, unexcluded, mechanism, warnings };
}
