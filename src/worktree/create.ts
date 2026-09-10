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
  getCurrentCommit,
  detectBaseBranch,
  getRepoRoot,
  checkGitVersion,
  slugify,
  randomHex,
  branchExists,
} from "../git/utils.js";
import { insertWithSlot } from "./slots.js";
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

  // Resolve repo root
  const repoRoot = getRepoRoot(projectPath);

  // Check max active limit
  const activeCount = store.countActive(repoRoot);
  if (activeCount >= config.maxActive) {
    throw new WorktreeError(
      `Maximum active worktrees (${config.maxActive}) reached. Merge or abandon existing worktrees first.`,
      "MAX_ACTIVE",
    );
  }

  // Detect base branch
  const base = baseBranch ?? detectBaseBranch(repoRoot);
  const baseCommit = getCurrentCommit(repoRoot);

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

  // Create the worktree
  gitExecOrThrow(
    ["worktree", "add", "-b", branchName, worktreePath, base],
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
