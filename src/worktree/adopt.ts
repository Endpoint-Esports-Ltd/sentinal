/**
 * `ensureWorktree` — create-or-adopt (orca D4).
 *
 * One entry point that yields a live, slotted, seeded worktree for a plan slug:
 *
 * - an existing live row for the slug → returned as-is (`existing`);
 * - no `path`, owner `sentinal` → today's reconcile-then-create (`created`);
 * - a `path` → ADOPT a worktree of the repo that Sentinal did not create, e.g.
 *   one made by Orca (`adopted`), recording `owner` and `slug` (V15).
 *
 * ⛔ An adopted directory is never Sentinal's to delete: a failure after the
 * insert deletes ONLY the row. `create.ts`'s rollback (`git worktree remove
 * --force`) must never run here.
 *
 * ⛔ Git runs only OUTSIDE transactions: the repo scope is resolved once, up
 * front, and handed to `insertWithSlot`.
 *
 * ⛔ Must import NOTHING from `src/runtime/` — `setup` arrives injected.
 */

import { existsSync } from "node:fs";
import { detectBaseBranch, gitExec, randomHex, slugify } from "../git/utils.js";
import {
  listGitWorktrees,
  resolveRealPath,
  type GitWorktreeEntry,
} from "./disk-scan.js";
import {
  createWorktreeWithSetup,
  resolveBaseCommit,
  runSetupNonFatally,
  type WorktreeSetupOutcome,
  type WorktreeSetupRunner,
} from "./create.js";
import { ensureSlot, resolveWithReconcile } from "./reconcile.js";
import {
  insertWithSlot,
  readSlotFromWorktree,
  resolveSlotScope,
  warnIfSlotMismatch,
  type SlotScope,
} from "./slots.js";
import type { WorktreeStore } from "./store.js";
import {
  LIVE_WORKTREE_STATUSES,
  WorktreeError,
  type Worktree,
  type WorktreeConfig,
  type WorktreeOwner,
} from "./types.js";
import { seedNonFatally } from "./worktree-config.js";

export interface EnsureWorktreeOptions {
  /** The plan slug. Stored slugified in the V15 `slug` column on adopt. */
  slug: string;
  /** Any checkout of the repo; the canonical project is derived from it. */
  project: string;
  /** An existing linked worktree of the repo to adopt. */
  path?: string;
  /** Base branch. REQUIRED for owner `external`. */
  base?: string;
  /** Default `sentinal`. `external` requires `path` and `base`. */
  owner?: WorktreeOwner;
  /**
   * Required to adopt an existing `path` as owner `sentinal` (Sentinal may then
   * delete it like its own). Ignored for creation and for `external`.
   */
  takeover?: boolean;
  /**
   * Seed per-slot config into an ADOPTED worktree (default true). A created
   * worktree is always seeded, inside its rollback envelope.
   */
  seed?: boolean;
  /** Once-per-worktree setup, run after seeding (created/adopted only). */
  setup?: WorktreeSetupRunner;
}

export type EnsuredWorktree = Worktree & {
  created: boolean;
  adopted: boolean;
  existing: boolean;
  /** Present only when `setup` was injected and a worktree was created/adopted. */
  setup?: WorktreeSetupOutcome;
};

type Kind = "created" | "adopted" | "existing";

function result(
  wt: Worktree,
  kind: Kind,
  setup?: WorktreeSetupOutcome,
): EnsuredWorktree {
  return {
    ...wt,
    created: kind === "created",
    adopted: kind === "adopted",
    existing: kind === "existing",
    ...(setup ? { setup } : {}),
  };
}

/**
 * Create or adopt the worktree for `opts.slug`. Idempotent; see the module doc.
 *
 * @throws WorktreeError — `NOT_A_REPO`, `CONFLICT` (bad input: external without
 *   path/base, main checkout, branch = base, detached), `NOT_FOUND` (path is not
 *   a worktree of the repo), `ALREADY_EXISTS` (slug or path bound to another
 *   row/owner), `GIT_ERROR` (base does not resolve), `MAX_ACTIVE`,
 *   `SLOT_EXHAUSTED`, plus anything `createWorktree` throws.
 */
export async function ensureWorktree(
  store: WorktreeStore,
  config: WorktreeConfig,
  opts: EnsureWorktreeOptions,
  warnings?: string[],
): Promise<EnsuredWorktree> {
  const owner = opts.owner ?? "sentinal";
  if (owner === "external" && (!opts.path || !opts.base)) {
    throw new WorktreeError(
      `Adopting an external worktree needs both a path and a base branch ` +
        `(got path=${opts.path ?? "none"}, base=${opts.base ?? "none"}). Nothing was recorded.`,
      "CONFLICT",
    );
  }

  // ONE `git worktree list`, outside any transaction; the entries are kept for
  // the branch lookup so adoption needs no second listing.
  let entries: GitWorktreeEntry[] = [];
  const scope = resolveSlotScope(opts.project, (root) => {
    entries = listGitWorktrees(root);
    return entries;
  });
  if (!scope) {
    throw new WorktreeError(
      `${opts.project} is not inside a git repository.`,
      "NOT_A_REPO",
    );
  }

  // An explicit runner wins; otherwise the one injected on the config (Task 9).
  const setup = opts.setup ?? config.runSetup;

  if (!opts.path) {
    const found = resolveWithReconcile(
      store,
      config,
      opts.slug,
      opts.project,
      warnings,
    );
    if (found) return result(found, "existing");
    const made = await createWorktreeWithSetup(
      store,
      config,
      opts.slug,
      opts.project,
      opts.base,
      warnings,
      setup,
    );
    return result(made.worktree, "created", made.setup);
  }

  const target = resolveRealPath(opts.path);
  const existing = findExisting(store, config, opts, owner, target, warnings);
  if (existing) return result(existing, "existing");
  // A Sentinal-owned row may later be DELETED by abandon/cleanup/merge, so
  // taking ownership of a worktree Sentinal did not create (Orca's, or the
  // coordinator's own checkout) must be explicit.
  if (owner === "sentinal" && !opts.takeover) {
    throw new WorktreeError(
      `${opts.path} was not created by Sentinal. Adopt it with owner "external" ` +
        `(Sentinal never deletes it), or pass takeover: true to let Sentinal own ` +
        `and later remove it. Nothing was recorded.`,
      "CONFLICT",
    );
  }
  return adopt(
    store,
    config,
    { ...opts, setup },
    owner,
    scope,
    entries,
    target,
    warnings,
  );
}

/** Step 2 of D4: the slug's live row, or a refusal — never a silent re-own. */
function findExisting(
  store: WorktreeStore,
  config: WorktreeConfig,
  opts: EnsureWorktreeOptions,
  owner: WorktreeOwner,
  target: string,
  warnings?: string[],
): Worktree | null {
  const bySlug = store.resolveBySlug(opts.slug, opts.project);
  if (bySlug && existsSync(bySlug.worktreePath)) {
    if (resolveRealPath(bySlug.worktreePath) !== target) {
      throw new WorktreeError(
        `Slug "${opts.slug}" is already bound to ${bySlug.worktreePath} (row ${bySlug.id}), ` +
          `not ${opts.path}. Abandon that worktree first.`,
        "ALREADY_EXISTS",
      );
    }
    if ((bySlug.owner ?? "sentinal") !== owner) {
      throw new WorktreeError(
        `${opts.path} is already recorded with owner "${bySlug.owner ?? "sentinal"}" (row ${bySlug.id}); ` +
          `refusing to re-own it as "${owner}". Abandon (release) it first, then ensure again.`,
        "ALREADY_EXISTS",
      );
    }
    return ensureSlot(store, config, bySlug, warnings);
  }
  // Self-heal, as reconcile does: a row whose directory is gone is dead.
  if (bySlug) store.updateStatus(bySlug.id, "abandoned");

  const live = new Set<string>(LIVE_WORKTREE_STATUSES);
  const holder = store
    .listAll()
    .find(
      (r) => live.has(r.status) && resolveRealPath(r.worktreePath) === target,
    );
  if (holder) {
    throw new WorktreeError(
      `${opts.path} is already recorded as row ${holder.id} ` +
        `(slug ${holder.slug ?? "none"}, owner ${holder.owner ?? "sentinal"}). ` +
        `Refusing to record it again under slug "${opts.slug}".`,
      "ALREADY_EXISTS",
    );
  }
  return null;
}

/** Step 4 of D4: validate membership, insert with owner + slug, seed, setup. */
async function adopt(
  store: WorktreeStore,
  config: WorktreeConfig,
  opts: EnsureWorktreeOptions,
  owner: WorktreeOwner,
  scope: SlotScope,
  entries: GitWorktreeEntry[],
  target: string,
  warnings?: string[],
): Promise<EnsuredWorktree> {
  const repoRoot = scope.key;
  if (!scope.roots.includes(target)) {
    throw new WorktreeError(
      `${opts.path} is not a worktree of ${repoRoot} (see \`git worktree list\`). Nothing was recorded.`,
      "NOT_FOUND",
    );
  }
  if (target === repoRoot) {
    throw new WorktreeError(
      `${opts.path} is the repository's main checkout; it can never be adopted as a worktree.`,
      "CONFLICT",
    );
  }
  const branch = entries.find(
    (e) => resolveRealPath(e.path) === target,
  )?.branch;
  if (!branch) {
    throw new WorktreeError(
      `${opts.path} has no branch checked out (detached HEAD); check out a branch before adopting it.`,
      "CONFLICT",
    );
  }
  const base = opts.base ?? detectBaseBranch(repoRoot);
  if (branch === base) {
    throw new WorktreeError(
      `${opts.path} has the base branch "${base}" checked out; a worktree must be on its own branch.`,
      "CONFLICT",
    );
  }
  const baseTip = resolveBaseCommit(repoRoot, base);
  const mergeBase = gitExec(["merge-base", base, branch], repoRoot);
  const baseCommit =
    mergeBase.exitCode === 0 && mergeBase.stdout.trim()
      ? mergeBase.stdout.trim()
      : baseTip;

  if (store.countActive(repoRoot, scope.roots) >= config.maxActive) {
    throw new WorktreeError(
      `Maximum active worktrees (${config.maxActive}) reached. Merge or abandon existing worktrees first.`,
      "MAX_ACTIVE",
    );
  }

  const onDiskSlot = readSlotFromWorktree(target);
  const wt = insertWithSlot(
    store,
    {
      id: `${slugify(opts.slug)}-${randomHex(4)}`,
      specId: undefined,
      projectPath: repoRoot,
      worktreePath: target,
      branchName: branch,
      baseBranch: base,
      baseCommit,
      status: "active",
      createdAt: Date.now(),
      owner,
      slug: opts.slug,
    },
    config.maxActive,
    { preferred: onDiskSlot, warnings, scope },
  );

  try {
    warnIfSlotMismatch(warnings, target, onDiskSlot, wt.slot);
    if (opts.seed ?? true) {
      seedNonFatally(
        {
          repoRoot,
          worktreePath: target,
          slot: wt.slot ?? null,
          sharedResources: config.sharedResourcesFor?.(target) ?? [],
          unknownTokens: config.unknownSentinalTokens,
        },
        warnings,
      );
    }
  } catch (err) {
    // ⛔ The row only — the directory and branch belong to their creator.
    store.delete(wt.id);
    throw err;
  }

  const setup = opts.setup
    ? await runSetupNonFatally(opts.setup, wt, warnings)
    : undefined;
  return result(wt, "adopted", setup);
}
