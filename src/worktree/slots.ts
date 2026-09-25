/**
 * Worktree Slot Allocation
 *
 * Every worktree gets an integer **slot**, unique among the *live* worktrees of
 * one project (D2). Sentinal makes no claim about what a project does with the
 * number — the only guarantee is: unique while live, reused only after release.
 *
 * ## Two rules that are easy to get wrong
 *
 * **⛔ Slot 0 is reserved for the developer's main checkout (D7).** Allocation
 * runs over the closed range `[1, maxActive]`. The main checkout is never a
 * worktree record, so without the reservation the first worktree would receive
 * the number the developer's own default stack is already using — exactly the
 * collision slots exist to prevent. Slot 0 is *not* counted against `maxActive`,
 * so capacity is unchanged (default 5 → slots 1-5).
 *
 * **⛔ There is no `releaseSlot()`, deliberately.** Release is *emergent* from
 * the `idx_wt_slot_live` partial unique index: the moment a row leaves
 * `('active','ready-to-merge')` — or is deleted — it drops out of the index and
 * `listLiveSlots` stops reporting it. Writing `SET slot = NULL` on release would
 * be actively harmful: it destroys the record of which slot a merged/abandoned
 * worktree held, which is what lets `resolveWithReconcile` hand a recovered
 * directory back the slot its own on-disk config was written against.
 * (One transient exception, D4: the LIVE loser of a collision revealed by the
 * canonical re-key is nulled inside the transaction and re-slotted right after
 * commit — see {@link reslotLosers}.)
 *
 * **⛔ The pool is the REPO, not the checkout (Task 12).** Rows written by older
 * versions may be keyed by whichever linked worktree they were created from.
 * Every allocation first unifies this repo's live rows under the canonical key
 * (`store.unifyLiveKeys`), with the repo's roots resolved by ONE
 * `git worktree list` BEFORE the transaction — never inside it.
 *
 * Allocator state lives in SQLite only — sidecar handlers construct a fresh
 * `WorktreeManager` per request, so instance memory would be worthless.
 *
 * ## Module layout
 *
 * This file is the public face and re-exports everything; import from here.
 * - `slot-env.ts` — constants, `readSlotFromWorktree`, `formatSlot` (a leaf, so
 *   `worktree-config.ts` can import it without a cycle)
 * - `slot-scope.ts` — `SlotScope`, `resolveSlotScope` (the one git call)
 * - `slot-pool.ts` — allocation, `insertWithSlot`, `tryAssignFreeSlot`,
 *   `reslotLosers` (⛔ the last two stay together)
 * - `slot-messages.ts` — every error/warning string
 */

export {
  MAIN_CHECKOUT_SLOT,
  FIRST_ALLOCATABLE_SLOT,
  SLOT_ENV_RELATIVE_PATH,
  SLOT_ENV_VAR,
  readSlotFromWorktree,
  formatSlot,
} from "./slot-env.js";
export {
  resolveSlotScope,
  type SlotScope,
  type WorktreeLister,
} from "./slot-scope.js";
export {
  findFreeSlot,
  isAllocatableSlot,
  allocateSlot,
  tryAllocateSlot,
  insertWithSlot,
  tryAssignFreeSlot,
  type InsertWithSlotOptions,
  type AssignSlotResult,
  type AssignSlotOptions,
} from "./slot-pool.js";
export { noFreeSlotWarning, warnIfSlotMismatch } from "./slot-messages.js";
