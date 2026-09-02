/**
 * Git Worktree Type Definitions
 *
 * Interfaces, enums, and Zod schemas for the git worktree system.
 */

import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const WORKTREE_STATUSES = [
  "active",
  "ready-to-merge",
  "merged",
  "abandoned",
] as const;

export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

/**
 * The **live** statuses — a worktree in one of these still has its directory on
 * disk, its seeded config, and (Phase 4) its running process group.
 *
 * ⛔ `ready-to-merge` is LIVE, not terminal. Treating it as terminal anywhere —
 * most importantly in the `worktrees.slot` partial unique index — would free a
 * running worktree's slot and hand it to a second worktree with colliding ports
 * and database names. Define the set once; use it everywhere.
 */
export const LIVE_WORKTREE_STATUSES = ["active", "ready-to-merge"] as const;

export type LiveWorktreeStatus = (typeof LIVE_WORKTREE_STATUSES)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const WorktreeSchema = z.object({
  id: z.string().min(1),
  specId: z.string().nullable().optional(),
  projectPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1),
  baseCommit: z.string().min(1),
  status: z.enum(WORKTREE_STATUSES),
  /**
   * Per-project runtime slot, unique among LIVE worktrees (see migration V12).
   * `null` means unassigned: either a pre-V12 row (allocated lazily on next
   * resolve) or a reconcile that found no free slot. **Slot 0 is reserved for
   * the developer's main checkout and is never allocated (D7).**
   */
  slot: z.number().int().nullable().optional(),
  createdAt: z.number(),
  mergedAt: z.number().nullable().optional(),
  mergeCommit: z.string().nullable().optional(),
});

export type Worktree = z.infer<typeof WorktreeSchema>;

/**
 * A `Worktree` plus the non-fatal problems raised while resolving it.
 *
 * ⛔ The warnings channel is why this type exists. `resolveWithReconcile` can
 * seed config, allocate a slot lazily, or fail to do either — and the caller is
 * usually an LLM. A worktree that was resolved but NOT seeded looks identical to
 * a seeded one from the outside, and the documented failure mode (issue #2) is
 * an agent filling that gap by copying the repo-root `.env` in. The field is
 * optional so `/worktree/resolve`'s response stays backward compatible with
 * consumers that only read `Worktree` fields.
 */
export interface ResolvedWorktree extends Worktree {
  warnings?: string[];
}

export const WorktreeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  directory: z.string().default(".sentinal/worktrees"),
  branchPrefix: z.string().default("sentinal/spec-"),
  maxActive: z.number().int().min(1).default(5),
  autoCleanup: z.boolean().default(true),
});

/**
 * The structural shape of `stopOwnedGroup`'s result (`src/runtime/teardown.ts`).
 *
 * ⛔ Declared here rather than imported, because `src/worktree/**` must import
 * NOTHING from `src/runtime/**` (`src/runtime/no-module-cycle.test.ts`). The
 * real `StopResult` carries extra optional fields and is structurally
 * assignable to this.
 */
export interface RuntimeStopOutcome {
  /** False means **nothing was signalled and the runtime may still be up**. */
  ok: boolean;
  /** True when this call actually tore something down. */
  stopped: boolean;
  actions: string[];
  warnings: string[];
  /** Present exactly when `ok` is false. */
  reason?: string;
}

/** The structural shape of `ownsLiveRuntime`'s verdict (`src/runtime/pidfile.ts`). */
export interface RuntimeLiveVerdict {
  /** True when this worktree may still own running processes. */
  live: boolean;
  detail?: string;
}

/**
 * The worktree config, plus the three runtime dependencies that are injected
 * **as data** (Task 6).
 *
 * ⛔ **All three exist to keep the module graph acyclic.** `src/runtime/` already
 * imports `readSlotFromWorktree`/`isIgnored` from this directory; importing the
 * runtime loader or teardown back would close a `worktree → runtime → worktree`
 * cycle that ESM compiles happily and then fails at runtime with an undefined
 * binding. Every one of these is therefore a plain function supplied by whoever
 * constructed the manager — see `src/runtime/worktree-deps.ts` for the single
 * production implementation and `src/runtime/worktree-deps.test.ts` for the
 * five-construction-site guard.
 *
 * All three are optional and default to inert, so a `WorktreeConfig` parsed
 * straight from the zod schema behaves exactly as it did before Phase 4.
 */
export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema> & {
  /**
   * Resource classes the worktree's own `.sentinal/runtime.json` declares
   * `"shared"` (R11). Feeds `notIsolatedWarning`, turning a blanket "may not be
   * isolated" into a named one. Defaults to `() => []`, which reproduces the
   * Phase 2 warning **byte-for-byte**.
   */
  sharedResourcesFor?: (worktreePath: string) => string[];
  /**
   * Stop the process group this worktree owns, before its directory is removed
   * (`abandon`, `squashMerge`). ⛔ Must be a **fast no-op** when no pidfile
   * exists — `abandon` calls it on every worktree, including ones that never
   * started a runtime (Pre-Mortem #2).
   *
   * ⛔ **REQUIRED, and it fails CLOSED.** This used to be optional, which meant
   * `DEFAULT_WORKTREE_CONFIG` left it `undefined`, the manager returned early,
   * and `abandon` removed a directory without stopping anything — the only
   * decision in this tier that failed OPEN. The single guard was a grep over
   * five known construction sites, so any new or external site silently
   * inherited the unsafe default. Making it required moves that guard into the
   * type system; {@link NO_RUNTIME_STOP} is how a caller says "nothing to
   * stop" **on purpose**, which is what keeps `undefined` meaning exactly one
   * thing: nobody decided.
   */
  stopOwnedRuntime: (worktreePath: string) => Promise<RuntimeStopOutcome>;
  /**
   * Every `${SENTINAL_*}` token in `text` that is not in the closed set
   * (`src/runtime/interpolate.ts`'s `unknownSentinalTokens`), returned with its
   * braces. Applied to each **seed source** before it is copied into the
   * worktree.
   *
   * ⛔ **REQUIRED for the same reason as {@link stopOwnedRuntime}.** The check
   * was previously applied to `runtime.json` fields only, so the `.env` seeding
   * path — the one that writes CREDENTIALS config — never ran it, and a
   * typo'd `${SENTINAL_WORKTREE_SLOTT}` was seeded verbatim to be expanded by
   * the shell into the empty string. An unwired checker is indistinguishable
   * from a clean file, so "unwired" must not be reachable by omission.
   * {@link NO_TOKEN_CHECK} is the declared opt-out.
   *
   * Only the `SENTINAL_` prefix is validated: `${PORT:-3000}` and bare `$VAR`
   * pass through verbatim (D6 as shipped).
   */
  unknownSentinalTokens: (text: string) => string[];
  /**
   * Does this worktree still own running processes? Guard 5 of the `force`
   * cleanup pass. ⛔ Conservative in the direction of NOT deleting: anything it
   * cannot rule out counts as live, because its answer authorises a directory
   * deletion.
   *
   * ⛔ **There is no permissive default.** Optional here only because
   * `cleanup.ts` accepts an equivalent per-call override; when NEITHER is
   * supplied the entire `force` pass is REFUSED with a warning naming the
   * wiring bug (`forceCleanupOrphans`). It therefore already fails closed, and
   * unlike the two required fields above it cannot silently authorise anything.
   */
  ownsLiveRuntime?: (worktreePath: string) => RuntimeLiveVerdict;
};

/**
 * The **declared** opt-out from stop-on-exit: "this manager owns no runtime".
 *
 * ⛔ Its whole purpose is to be distinguishable from `undefined`. A caller that
 * genuinely has nothing to stop names this constant; a caller that forgot to
 * wire the dep leaves `undefined`, and the manager refuses the exit path. Both
 * behave identically at run time — the difference is entirely in whether a
 * human made the call, which is exactly the distinction the old optional field
 * threw away.
 *
 * ⛔ Compared by **identity** in tests, so it must stay a single shared
 * instance and never be re-created per call.
 */
export const NO_RUNTIME_STOP = async (
  _worktreePath: string,
): Promise<RuntimeStopOutcome> => ({
  ok: true,
  stopped: false,
  actions: ["no runtime stop resolver was wired (declared opt-out)"],
  warnings: [],
});

/** The declared opt-out from seed-source token validation. See {@link NO_RUNTIME_STOP}. */
export const NO_TOKEN_CHECK = (_text: string): string[] => [];

/**
 * The inert baseline every test and non-injecting caller builds on.
 *
 * ⛔ It **declares** both opt-outs rather than leaving them `undefined`. That
 * is what lets the two required deps fail closed without taxing every test in
 * the suite with a hand-written stub: spreading this config is already an
 * explicit statement of intent.
 */
export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  ...WorktreeConfigSchema.parse({}),
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
};

// ─── Diff Types ───────────────────────────────────────────────────────────────

export interface DiffFileSummary {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: DiffFileSummary[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "GIT_TOO_OLD"
      | "NOT_A_REPO"
      | "MAX_ACTIVE"
      | "NOT_FOUND"
      | "CONFLICT"
      | "GIT_ERROR"
      | "ALREADY_EXISTS"
      /**
       * The allocator determined **from data** that every slot in
       * [1, maxActive] is held by a live worktree. Actionable: merge, abandon,
       * or `worktree_cleanup`.
       */
      | "SLOT_EXHAUSTED"
      /**
       * Another process took the slot between our SELECT and INSERT, on every
       * retry. ⛔ Distinct from SLOT_EXHAUSTED on purpose: this is transient
       * and self-resolving, so it must NOT tell the user to delete healthy
       * worktrees.
       */
      | "SLOT_RACE"
      /**
       * A directory-removing exit path (`abandon`, `squashMerge`) asked the
       * injected `stopOwnedRuntime` to stop the process group this worktree
       * owns, and it **refused or failed**. ⛔ The removal is then abandoned
       * too: deleting a directory out from under a live process is the orphan
       * this whole tier exists to prevent, and "we could not stop it" is never
       * a licence to delete it anyway.
       */
      | "RUNTIME_STOP_FAILED"
      /**
       * `squashMerge` found modified-or-untracked files in the worktree and
       * refused **before touching anything**.
       *
       * ⛔ Those files are not in the branch, so `git merge --squash` would not
       * carry them across — and `git worktree remove` (no `--force`, because a
       * merge is not a discard) then refuses, leaving a directory that still
       * holds the only copy. Merging anyway would drop the user's work AND
       * free the slot. Nothing has been done when this is thrown; the merge can
       * be retried verbatim once the files are committed or removed.
       */
      | "DIRTY_WORKTREE"
      /**
       * `squashMerge` found staged or modified TRACKED files in the MAIN
       * checkout (`projectPath`) and refused **before touching anything**.
       *
       * ⛔ Distinct from DIRTY_WORKTREE: the dirt is on the other side of the
       * merge. `squashMerge` runs `git checkout base` + `git commit` in the
       * main checkout, so staged edits there would be silently committed INTO
       * the spec's squash commit. Untracked files do NOT trigger this —
       * `git commit -m` cannot commit them. Nothing has been done when this is
       * thrown; commit or stash in the main checkout and retry verbatim.
       */
      | "DIRTY_MAIN_CHECKOUT"
      /**
       * The squash merge **landed on the base branch**, but the worktree
       * directory could not be removed afterwards.
       *
       * ⛔ Distinct from DIRTY_WORKTREE precisely because the merge is already
       * committed and must not be retried. The row is deliberately left LIVE:
       * `merged` is terminal and would release the slot to a second worktree
       * while this one's directory, seeded `.env` and ports are still on disk.
       */
      | "REMOVE_FAILED",
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}
