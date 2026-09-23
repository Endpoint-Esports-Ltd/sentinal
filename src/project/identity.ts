/**
 * Project Identity — the two root resolvers
 *
 * Sentinal has to answer two DIFFERENT questions about "where am I", and
 * conflating them is the bug this module exists to make impossible:
 *
 *   • `resolveProjectIdentity(cwd)` → the **canonical project key**.
 *     ⛔ STORAGE KEYS ONLY. Memory rows, spec rows, session rows, sidecar
 *     project filters. Every linked worktree of a repo MUST map to the SAME
 *     key as the main checkout, or observations recorded from a worktree are
 *     invisible from the main checkout (and vice versa).
 *
 *   • `resolveWorkspaceRoot(cwd)` → the **local checkout root**.
 *     ⛔ FILESYSTEM WRITES ONLY. `.sentinal/` state, plan files, generated
 *     artifacts. These must land in the checkout the user is actually editing,
 *     never be redirected to the main checkout.
 *
 * The one-line rule: **identity → storage keys ONLY; workspace → filesystem
 * writes ONLY.** If a call site wants both, it must call both.
 *
 * Neither function throws, and neither can return `""`. The empty-string
 * guarantee is load-bearing: `projectRoot ?? ""` in the OpenCode plugin wrote
 * 14 empty-key rows into the live database, and an empty key silently matches
 * nothing and groups everything.
 *
 * ⛔ Keep this module free of any import that transitively reaches
 * `bun:sqlite` — it is bundled into the OpenCode plugin by `bun build`.
 * Git helpers + `node:fs`/`node:path` only.
 *
 * Both functions are SYNCHRONOUS, matching `src/git/utils.ts`.
 */

import { getMainWorktreeRoot, getRepoRoot } from "../git/utils.js";
import { resolveRealPath } from "../worktree/disk-scan.js";

/**
 * Turn a caller-supplied `cwd` into something safe to hand to `git`.
 *
 * An absent / blank path means "wherever this process is", NOT "the filesystem
 * root" and NOT the empty string. Only a fully blank value is substituted — a
 * real directory may legitimately have leading or trailing whitespace in its
 * name, so the input is never trimmed in place.
 */
function normalizeStart(cwd: string): string {
  if (typeof cwd !== "string" || cwd.trim() === "") return process.cwd();
  return cwd;
}

/** Last-resort canonical path that is guaranteed non-empty and absolute. */
function safeRealPath(p: string): string {
  const resolved = resolveRealPath(p);
  if (resolved && resolved.trim() !== "") return resolved;
  return resolveRealPath(process.cwd());
}

/**
 * The CANONICAL project key — stable across every worktree of a repository.
 *
 * Layered, and **never throws**:
 *   1. `getMainWorktreeRoot(cwd)` — the original checkout, even from a linked
 *      worktree or a subdirectory of one.
 *   2. `getRepoRoot(cwd)` — `--show-toplevel`; today's behaviour, used when
 *      `git worktree list` is unavailable (very old git, odd repo layouts).
 *   3. `resolveRealPath(cwd)` — outside a repository entirely.
 *
 * ⛔ Use for STORAGE KEYS ONLY. Writing files under this path would leak edits
 * from a worktree into the main checkout.
 */
export function resolveProjectIdentity(cwd: string): string {
  const start = normalizeStart(cwd);

  try {
    const main = getMainWorktreeRoot(start);
    if (main && main.trim() !== "") return main;
  } catch {
    /* fall through to --show-toplevel */
  }

  try {
    const root = getRepoRoot(start);
    if (root && root.trim() !== "") return root;
  } catch {
    /* fall through to the filesystem */
  }

  return safeRealPath(start);
}

/**
 * The LOCAL checkout root — the worktree the caller is actually standing in.
 *
 * `getRepoRoot(cwd)` with a `resolveRealPath(cwd)` fallback. This is
 * deliberately today's behaviour; the function exists so that call sites
 * DECLARE which of the two roots they mean instead of reaching for
 * `getRepoRoot` and leaving the intent ambiguous.
 *
 * ⛔ Use for FILESYSTEM WRITES ONLY. Never use as a storage key — it differs
 * per worktree and fragments a project's records.
 */
export function resolveWorkspaceRoot(cwd: string): string {
  const start = normalizeStart(cwd);

  try {
    const root = getRepoRoot(start);
    if (root && root.trim() !== "") return root;
  } catch {
    /* fall through to the filesystem */
  }

  return safeRealPath(start);
}
