/**
 * Spec Plans Directory Resolution
 *
 * Resolves where plan files should be created, ensuring that plans created
 * under a worktree are written to THAT WORKTREE's docs/plans/ directory,
 * not the main checkout's. This is the structural fix for cross-session
 * stop-guard false positives caused by worktree plans landing in the main
 * checkout.
 *
 * Usage in planning skills/commands:
 *   After worktree_create returns { path: worktreePath }, use:
 *     resolvePlansDir({ worktreePath, cwd })        → <worktreePath>/docs/plans
 *     resolvePlanFilePath({ slug, date, worktreePath, cwd })
 */

import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolvePlansDirOptions {
  /** Worktree root path returned by worktree_create/worktree_detect. Optional. */
  worktreePath?: string | null | undefined;
  /** Current working directory (main checkout root). Used as fallback. */
  cwd: string;
}

export interface ResolvePlanFilePathOptions extends ResolvePlansDirOptions {
  /** Plan slug (e.g. "my-feature"). */
  slug: string;
  /** Date prefix in YYYY-MM-DD format. Defaults to today's date. */
  date?: string;
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Returns the correct docs/plans directory for a plan file.
 *
 * - When a worktreePath is provided (non-empty): returns <worktreePath>/docs/plans
 * - Otherwise: returns <cwd>/docs/plans
 *
 * This ensures a worktree session's plan is written to the worktree's own
 * docs/plans, NOT the main checkout's (which would make other sessions
 * see the plan and potentially cross-block).
 */
export function resolvePlansDir(opts: ResolvePlansDirOptions): string {
  const base = opts.worktreePath || opts.cwd;
  return join(base, "docs", "plans");
}

/**
 * Returns the full file path for a plan file.
 *
 * Example: resolvePlanFilePath({ slug: "my-feature", date: "2026-06-10", worktreePath: "/wt" })
 * → "/wt/docs/plans/2026-06-10-my-feature.md"
 */
export function resolvePlanFilePath(opts: ResolvePlanFilePathOptions): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const filename = `${date}-${opts.slug}.md`;
  return join(resolvePlansDir(opts), filename);
}
