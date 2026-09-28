/**
 * Worktree creation — `git worktree add`, slot allocation and config seeding,
 * all inside one rollback envelope.
 *
 * Extracted verbatim from `manager.ts` (precedent: `diff-parse.ts`,
 * `disk-scan.ts`). `WorktreeManager.create()` now delegates here.
 *
 * ⛔ Must import NOTHING from `src/runtime/` — see
 * `src/runtime/no-module-cycle.test.ts`.
 */

import { join } from "node:path";
import { WorktreeStore } from "./store.js";
import {
  gitExec,
  gitExecOrThrow,
  detectBaseBranch,
  getRepoRoot,
  checkGitVersion,
  slugify,
  randomHex,
  branchExists,
} from "../git/utils.js";
import { insertWithSlot, resolveSlotScope } from "./slots.js";
import { seedWorktreeConfig } from "./worktree-config.js";
import { WorktreeError, type Worktree, type WorktreeConfig } from "./types.js";

/**
 * Create a new git worktree for a spec.
 * Creates a branch and worktree directory, records in SQLite.
 *
 * @param warnings - optional collector for non-fatal problems raised while
 *   seeding config (missing `.env.example`, a non-isolated seed source, a
 *   file that could not be hidden from git). Callers that surface output to a
 *   human or an LLM should pass one — a silently unseeded worktree is what
 *   sends an agent back to copying the repo-root `.env`.
 */
export function createWorktree(
  store: WorktreeStore,
  config: WorktreeConfig,
  specId: string | undefined,
  projectPath: string,
  baseBranch?: string,
  warnings?: string[],
): Worktree {
  // Check git version
  const versionCheck = checkGitVersion();
  if (!versionCheck.ok) {
    throw new WorktreeError(versionCheck.warning!, "GIT_TOO_OLD");
  }

  // Task 13 — un-nesting. Resolve the repo's scope ONCE (one git call, before
  // any transaction) and reuse it for the count, the insert and the paths.
  // `repoRoot` is the CANONICAL project — the main checkout — even when the
  // caller stands in a linked worktree. `getRepoRoot` is only the fallback
  // (and the NOT_A_REPO error) when `git worktree list` yields nothing.
  //
  // ⛔ Deliberate, documented exception to "identity is for storage keys
  // only": the new worktree's DIRECTORY is placed under the canonical root.
  // Nesting it under the invoking linked checkout (the old behaviour) hid it
  // from every other checkout and split its record across two project keys.
  const scope = resolveSlotScope(projectPath);
  const repoRoot = scope?.key ?? getRepoRoot(projectPath);

  // Check max active limit — over the canonical set, legacy keys included.
  const activeCount = store.countActive(repoRoot, scope?.roots);
  if (activeCount >= config.maxActive) {
    throw new WorktreeError(
      `Maximum active worktrees (${config.maxActive}) reached. Merge or abandon existing worktrees first.`,
      "MAX_ACTIVE",
    );
  }

  // Detect base branch, and record the commit the worktree ACTUALLY branches
  // from — the base's tip, not the invoking checkout's HEAD.
  const base = baseBranch ?? detectBaseBranch(repoRoot);
  const baseCommit = resolveBaseCommit(repoRoot, base);

  // Generate identifiers
  const slug = specId ? slugify(specId) : `worktree-${randomHex(4)}`;
  const hash = randomHex(4);
  const id = `${slug}-${hash}`;
  const branchName = `${config.branchPrefix}${slug}`;
  const worktreePath = join(repoRoot, config.directory, `spec-${slug}-${hash}`);

  // Check if branch already exists
  if (branchExists(repoRoot, branchName)) {
    throw new WorktreeError(
      `Branch ${branchName} already exists. Abandon the existing worktree first.`,
      "ALREADY_EXISTS",
    );
  }

  // Create the worktree — from the exact commit recorded as `baseCommit`, so
  // the two can never disagree if `base` moves in between.
  gitExecOrThrow(
    ["worktree", "add", "-b", branchName, worktreePath, baseCommit],
    repoRoot,
  );

  // Record in SQLite — always insert with spec_id=NULL to avoid FK constraint
  // failures when the spec hasn't been registered yet (normal workflow ordering).
  // Use linkSpec() after spec registration to set the spec_id.
  try {
    // Allocate the slot INSIDE the rollback envelope: a failure here must
    // remove the git worktree too, or countActive and the slot pool diverge.
    //
    // ⚠️ SLOT_EXHAUSTED IS reachable from here. The MAX_ACTIVE guard above
    // uses `countActive` ('active' only) while the pool is scoped to the LIVE
    // set ('active' + 'ready-to-merge'), so `ready-to-merge` rows can hold
    // every slot while the guard still passes. That is the right error — its
    // message names merge/abandon/worktree_cleanup, which is exactly the
    // remedy — but it is NOT unreachable, and the rollback below is what
    // keeps the git worktree from surviving it.
    const wt = insertWithSlot(
      store,
      {
        id,
        specId: undefined,
        projectPath: repoRoot,
        worktreePath,
        branchName,
        baseBranch: base,
        baseCommit,
        status: "active",
        createdAt: Date.now(),
      },
      config.maxActive,
      { scope },
    );

    // Seed config INSIDE the rollback envelope (D8). The slot only exists
    // after the insert above, and seeding after the try would leave a DB row
    // plus a half-written worktree with no compensating teardown.
    const seed = seedWorktreeConfig({
      repoRoot,
      worktreePath,
      slot: wt.slot ?? null,
      // R11: the names arrive as DATA (`config.sharedResourcesFor`), because
      // this directory may not import `src/runtime/`. Resolved against the
      // WORKTREE — `git worktree add` has just given it a copy of the committed
      // `.sentinal/runtime.json`, and that copy is what the run will use.
      sharedResources: config.sharedResourcesFor?.(worktreePath) ?? [],
      // Seed site 1 of 3 for the `${SENTINAL_*}` typo check — also data, and
      // for the same module-cycle reason as `sharedResources` above.
      unknownTokens: config.unknownSentinalTokens,
    });
    warnings?.push(...seed.warnings);

    return wt;
  } catch (err) {
    // Cleanup: remove the git worktree AND any row already inserted. Seeding
    // runs after the insert, so a seeding failure must undo both.
    gitExec(["worktree", "remove", "--force", worktreePath], repoRoot);
    try {
      store.delete(id);
    } catch {
      // Best effort — the git worktree is already gone.
    }
    throw err;
  }
}

// ─── Setup step (orca D5) ────────────────────────────────────────────────────

/**
 * Outcome of the once-per-worktree `setup` command. Structurally identical to
 * `src/runtime/setup.ts`'s `WorktreeSetupResult`, re-declared here because
 * this directory may not import `src/runtime/` (`no-module-cycle.test.ts`).
 */
export interface WorktreeSetupOutcome {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  reason?: string;
}

/**
 * Injected by the caller: loads the worktree's runtime contract and runs its
 * `setup` (production: `runWorktreeSetup`). Returns `ok: true, ran: false`
 * when nothing is declared.
 */
export type WorktreeSetupRunner = (
  worktreePath: string,
  slot: number | null,
) => Promise<WorktreeSetupOutcome>;

/**
 * Run the injected setup ONCE, after seeding. ⛔ Never throws and never part of
 * a rollback: a failure — reported or thrown — becomes a warning and the
 * worktree stays (a half-installed tree is still the user's work).
 */
export async function runSetupNonFatally(
  setup: WorktreeSetupRunner,
  wt: Worktree,
  warnings?: string[],
): Promise<WorktreeSetupOutcome> {
  let result: WorktreeSetupOutcome;
  try {
    result = await setup(wt.worktreePath, wt.slot ?? null);
  } catch (err) {
    result = {
      ran: false,
      ok: false,
      exitCode: null,
      timedOut: false,
      tail: "",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    const why = result.timedOut
      ? "timed out"
      : result.exitCode !== null
        ? `exited ${result.exitCode}`
        : "did not complete";
    warnings?.push(
      `setup ${why} in ${wt.worktreePath}` +
        (result.reason ? `: ${result.reason}` : "") +
        (result.tail ? `\n--- output tail ---\n${result.tail}` : "") +
        `\nThe worktree was kept. Fix the cause and re-run the setup command by hand ` +
        `(full output in .sentinal/runtime.log).`,
    );
  }
  return result;
}

/**
 * {@link createWorktree}, then the injected `setup` — OUTSIDE the rollback
 * envelope, so a setup failure is a warning and never removes the worktree.
 * Without `setup` this is exactly `createWorktree`.
 */
export async function createWorktreeWithSetup(
  store: WorktreeStore,
  config: WorktreeConfig,
  specId: string | undefined,
  projectPath: string,
  baseBranch?: string,
  warnings?: string[],
  setup?: WorktreeSetupRunner,
): Promise<{ worktree: Worktree; setup?: WorktreeSetupOutcome }> {
  const worktree = createWorktree(
    store,
    config,
    specId,
    projectPath,
    baseBranch,
    warnings,
  );
  if (!setup) return { worktree };
  return {
    worktree,
    setup: await runSetupNonFatally(setup, worktree, warnings),
  };
}

/**
 * The commit `base` points at, verified. Throws a `GIT_ERROR` naming the base
 * when it does not resolve — before anything has been created.
 */
export function resolveBaseCommit(repoRoot: string, base: string): string {
  const r = gitExec(
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    repoRoot,
  );
  if (r.exitCode !== 0 || !r.stdout) {
    throw new WorktreeError(
      `Base branch "${base}" does not resolve to a commit in ${repoRoot}. ` +
        `Pass an existing branch as the base. Nothing was created.`,
      "GIT_ERROR",
    );
  }
  return r.stdout;
}
