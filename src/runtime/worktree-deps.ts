/**
 * The single place the runtime domain is handed to the worktree domain.
 *
 * ## Why this file exists at all
 *
 * `src/worktree/**` may import NOTHING from `src/runtime/**` — the dependency
 * runs one way only (`src/runtime/loader.ts` imports `readSlotFromWorktree` and
 * `isIgnored` from `src/worktree/`), and reversing it would close a cycle that
 * ESM compiles happily and then fails at runtime with an undefined binding.
 * `src/runtime/no-module-cycle.test.ts` enforces it recursively, including
 * indirection through the `src/index.ts` barrel.
 *
 * So the three runtime capabilities the worktree lifecycle needs travel as
 * **data**: plain functions hung off `WorktreeConfig`, supplied by whoever
 * constructs the manager. This module is the production supplier, and the only
 * one — five construction sites call it, and duplicating the resolver bodies at
 * each would be five chances to drift.
 *
 * ⛔ `src/worktree/mcp-tools.ts` constructs a manager while living **inside**
 * the forbidden directory, so it cannot call this. `src/mcp/server.ts` calls it
 * and threads the result down as a dep. That indirection is not incidental —
 * removing it reintroduces the cycle.
 */

import { loadRuntimeConfig } from "./loader.js";
import { stopOwnedGroup } from "./teardown.js";
import { ownsLiveRuntime } from "./pidfile.js";
import { unknownSentinalTokens } from "./interpolate.js";
import {
  DEFAULT_WORKTREE_CONFIG,
  type WorktreeConfig,
} from "../worktree/types.js";

/**
 * `base` with the four runtime dependencies injected.
 *
 * Each resolver is total and non-throwing by construction:
 *
 * - `loadRuntimeConfig` never throws; an absent contract is an inert success
 *   yielding `sharedResources: []`, so the seeding warning stays byte-identical
 *   to the Phase 2 baseline for any project without a `.sentinal/runtime.json`.
 * - `stopOwnedGroup` never throws and short-circuits on an absent pidfile, so
 *   `abandon` on a worktree that never started anything pays no grace period.
 * - `ownsLiveRuntime` reports anything it cannot rule out as live, because its
 *   answer authorises a directory deletion.
 * - `unknownSentinalTokens` is a pure regex scan over one string.
 *
 * ⛔ `stopOwnedRuntime` and `unknownSentinalTokens` are **required** fields on
 * `WorktreeConfig`, so a construction site that skips this helper no longer
 * merely degrades — it fails to compile. That is deliberate: both used to be
 * optional-and-inert, which made "forgot to wire it" indistinguishable from
 * "nothing to do", and the only guard was the grep over known sites below.
 */
export function runtimeWorktreeConfig(
  base: WorktreeConfig = DEFAULT_WORKTREE_CONFIG,
): WorktreeConfig {
  return {
    ...base,
    sharedResourcesFor: (worktreePath) =>
      loadRuntimeConfig(worktreePath).sharedResources,
    stopOwnedRuntime: (worktreePath) => stopOwnedGroup(worktreePath),
    ownsLiveRuntime: (worktreePath) => ownsLiveRuntime(worktreePath),
    // ⛔ The seeding path is the one that writes CREDENTIALS config, and until
    // now it was the only interpolated surface the typo check never reached.
    unknownSentinalTokens: (text) => unknownSentinalTokens(text),
  };
}
