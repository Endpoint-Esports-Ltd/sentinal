/**
 * Project key normalization for sidecar routes — the ONE implementation.
 *
 * Every linked worktree of a repository must collapse to the SAME key as its
 * main checkout, or observations recorded from a worktree are invisible from
 * the main checkout and sessions fragment per-worktree (breaking
 * `isSessionAlive` liveness and the dashboard's per-project grouping).
 *
 * ⛔ The sidecar's own `process.cwd()` is MEANINGLESS here. This is a detached,
 * long-lived process whose cwd is unrelated to any caller — the same
 * prohibition documented at `src/sidecar/worktree-routes.ts` and
 * `src/worktree/cleanup.ts`. `resolveProjectIdentity("")` would substitute
 * `process.cwd()`, i.e. "some arbitrary directory the sidecar happened to be
 * spawned in", so blank values are rejected BEFORE resolving.
 *
 * Two variants, deliberately different (D3 — writes normalize, reads fail open):
 * - `normalizeProjectKey` (WRITE): blank/absent → `null`, and the caller MUST
 *   reject. Storing `""` is forbidden — an empty key matches nothing and
 *   groups everything.
 * - `normalizeProjectFilter` (READ): blank/absent → `undefined`, meaning
 *   "all projects".
 *
 * Plus `canonicalProjectKey`, used by `SpecStore` on both its write point and
 * its project-keyed reads, and `inferProjectFromFile` (D4).
 *
 * ⛔ Keep this module free of `bun:sqlite` — `SpecStore` and hooks import it.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import * as identity from "../project/identity.js";

/** The 400 message for a write route given no usable project. */
export const MISSING_PROJECT_PATH =
  "Missing or empty 'projectPath' — the sidecar cannot infer it from its own " +
  "cwd, and refuses to store an empty project key";

// ─── Memo ─────────────────────────────────────────────────────────────────────
//
// `resolveProjectIdentity` spawns git (~15 ms). A sidecar route canonicalizes
// and then `SpecStore` canonicalizes the (already canonical) value again, on a
// path the OpenCode pre-edit guard hits for every edit. A short-lived memo makes
// the second call free. The TTL bounds staleness in the long-lived sidecar
// (a directory that later becomes a repo re-resolves within seconds).

const MEMO_TTL_MS = 10_000;
const MEMO_MAX = 512;
const memo = new Map<string, { value: string; at: number }>();

/**
 * The canonical STORAGE KEY for a non-blank project path (memoized
 * `resolveProjectIdentity`). Idempotent. A blank value is returned unchanged
 * — never resolved against the process cwd — so it simply matches nothing.
 */
export function canonicalProjectKey(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return raw;
  const now = Date.now();
  const hit = memo.get(raw);
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.value;

  const value = identity.resolveProjectIdentity(raw);
  if (!value || value.trim() === "") return raw;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(raw, { value, at: now });
  // Identity is idempotent: the canonical output maps to itself.
  memo.set(value, { value, at: now });
  return value;
}

/**
 * Canonicalize a caller-supplied project for use as a STORAGE KEY, or `null`
 * when it is absent/blank (the caller must then reject the request).
 */
export function normalizeProjectKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const resolved = canonicalProjectKey(raw);
  return resolved && resolved.trim() !== "" ? resolved : null;
}

/**
 * Canonicalize a caller-supplied project FILTER for a read, or `undefined`
 * when it is absent/blank — which on a read means "all projects".
 */
export function normalizeProjectFilter(raw: unknown): string | undefined {
  return normalizeProjectKey(raw) ?? undefined;
}

/**
 * D4 — infer the project of a file from the file itself: the canonical
 * identity of the nearest EXISTING ancestor of `dirname(filePath)` (the file,
 * and even its directory, may not exist yet). `null` for a relative or blank
 * path: resolving one would mean resolving against the sidecar's own cwd.
 */
export function inferProjectFromFile(filePath: unknown): string | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  if (!isAbsolute(filePath)) return null;
  let dir = dirname(filePath);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return normalizeProjectKey(dir);
}
