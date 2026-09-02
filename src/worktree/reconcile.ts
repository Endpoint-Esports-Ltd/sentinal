/**
 * Slug → worktree resolution, reconciled against the filesystem, plus the lazy
 * slot assurance it depends on.
 *
 * Extracted verbatim from `manager.ts` (same precedent as `diff-parse.ts` and
 * `disk-scan.ts`, both of which say "Extracted verbatim from `manager.ts`").
 * `WorktreeManager.resolveWithReconcile()` is now a delegating one-liner.
 *
 * ⛔ This module must import NOTHING from `src/runtime/` — see
 * `src/runtime/no-module-cycle.test.ts`. The R11 shared-resource names arrive
 * as **data**, via the injected `config.sharedResourcesFor` resolver.
 */

import { existsSync } from "node:fs";
import { WorktreeStore } from "./store.js";
import { listGitWorktrees } from "./disk-scan.js";
import {
  gitExec,
  getRepoRoot,
  detectBaseBranch,
  slugify,
  randomHex,
} from "../git/utils.js";
import {
  insertWithSlot,
  tryAssignFreeSlot,
  readSlotFromWorktree,
  warnIfSlotMismatch,
} from "./slots.js";
import { seedNonFatally } from "./worktree-config.js";
import type { Worktree, WorktreeConfig } from "./types.js";

/**
 * Resolve a plan slug to a worktree, reconciling against the filesystem.
 * The on-disk state is authoritative:
 * - Index hit + directory exists → return it.
 * - Index hit + directory gone → mark abandoned, then try the disk scan.
 * - Index miss + git worktree on disk (e.g. the DB insert was lost to a
 *   transport failure, or the record was wrongly abandoned) → re-register
 *   it as active and return it.
 *
 * ⛔ This sits on the `worktree_detect` read path and **must never throw for
 * slot reasons**. Unlike `create()` it has no `maxActive` guard, so it is the
 * only realistic way to ask for a slot when the pool is full — in which case
 * it returns the worktree with `slot = null` and pushes a warning.
 *
 * @param warnings - optional collector for non-fatal problems (e.g. no free
 *   slot). Callers that surface output to a human/LLM should pass one.
 */
export function resolveWithReconcile(
  store: WorktreeStore,
  config: WorktreeConfig,
  slug: string,
  projectPath?: string,
  warnings?: string[],
): Worktree | null {
  const fromDb = store.resolveBySlug(slug, projectPath);
  /** Slot held by the row self-healed below — the recovery candidate. */
  let priorSlot: number | null = null;
  if (fromDb) {
    if (existsSync(fromDb.worktreePath)) {
      return ensureSlot(store, config, fromDb, warnings);
    }
    priorSlot = fromDb.slot ?? null;
    // Self-heal: directory gone — don't keep returning a dead record
    store.updateStatus(fromDb.id, "abandoned");
  }

  if (!projectPath) return null;

  let repoRoot: string;
  try {
    repoRoot = getRepoRoot(projectPath);
  } catch {
    return null;
  }

  // Disk scan: find a git worktree whose branch matches the slug. Exact match
  // only (D1): branches are NEVER suffixed — only the row id and the worktree
  // path carry the `-<hash>` — so a `startsWith` arm matches nothing `===`
  // misses, while it DOES adopt a different slug's worktree whenever the
  // wanted slug is a strict prefix of it (`add` vs `add-auth`).
  const wanted = `${config.branchPrefix}${slugify(slug)}`;
  const onDisk = listGitWorktrees(repoRoot).find(
    (w) => w.branch === wanted && existsSync(w.path),
  );
  if (!onDisk) return null;

  // Re-register: disk is authoritative
  const base = detectBaseBranch(repoRoot);
  const mergeBase = gitExec(["merge-base", base, onDisk.branch], repoRoot);
  const baseCommit =
    mergeBase.exitCode === 0 && mergeBase.stdout.trim()
      ? mergeBase.stdout.trim()
      : onDisk.head;

  // The directory's OWN env file is the authoritative recovery source — read
  // it once, because the mismatch check below needs the same value.
  const onDiskSlot = readSlotFromWorktree(onDisk.path);

  const reregistered = insertWithSlot(
    store,
    {
      id: `${slugify(slug)}-${randomHex(4)}`,
      specId: undefined,
      projectPath: repoRoot,
      worktreePath: onDisk.path,
      branchName: onDisk.branch,
      baseBranch: base,
      baseCommit,
      status: "active",
      createdAt: Date.now(),
    },
    config.maxActive,
    {
      // That value is what its seeded `.env` was written against, so any
      // other choice hands the directory a slot contradicting its own config.
      // The row just abandoned above is the fallback.
      preferred: onDiskSlot ?? priorSlot,
      onExhausted: "null",
      warnings,
    },
  );

  // `preferred` is best-effort — if the directory's own slot was taken it got
  // a different one, and its `.env` now points at another worktree's
  // resources. Say so explicitly instead of leaving both files disagreeing.
  warnIfSlotMismatch(warnings, onDisk.path, onDiskSlot, reregistered.slot);

  // Rule 0 protects the hand-edited `.env` this directory may already carry.
  seedNonFatally(
    {
      repoRoot,
      worktreePath: reregistered.worktreePath,
      slot: reregistered.slot ?? null,
      // R11 seed site 2 of 3 — resolved against THIS site's own path variable.
      sharedResources:
        config.sharedResourcesFor?.(reregistered.worktreePath) ?? [],
      // Typo check, seed site 2 of 3.
      unknownTokens: config.unknownSentinalTokens,
    },
    warnings,
  );
  return reregistered;
}

/**
 * Lazily allocate a slot for a live row that has none.
 *
 * Rows created before migration V12 carry `slot = NULL` and are deliberately
 * not backfilled; they get a slot the first time they are resolved.
 *
 * ⛔ **Never throws.** This runs on the detect path, and allocate-then-assign
 * is the same read-then-write race as allocate-then-insert:
 * {@link tryAssignFreeSlot} wraps it in `BEGIN IMMEDIATE` + retry and
 * degrades every residual failure to `slot = null` plus a warning.
 */
export function ensureSlot(
  store: WorktreeStore,
  config: WorktreeConfig,
  wt: Worktree,
  warnings?: string[],
): Worktree {
  if (wt.slot != null) return wt;

  const { slot, warning } = tryAssignFreeSlot(
    store,
    wt.id,
    wt.projectPath,
    config.maxActive,
  );
  if (slot === null) {
    if (warning) warnings?.push(warning);
    return wt;
  }
  // The directory predates slots, so it has no `.sentinal/worktree.env`.
  // Seed once, on the null → slot transition only.
  seedNonFatally(
    {
      repoRoot: wt.projectPath,
      worktreePath: wt.worktreePath,
      slot,
      // R11 seed site 3 of 3 — resolved against THIS site's own path variable.
      sharedResources: config.sharedResourcesFor?.(wt.worktreePath) ?? [],
      // Typo check, seed site 3 of 3.
      unknownTokens: config.unknownSentinalTokens,
    },
    warnings,
  );
  return { ...wt, slot };
}
