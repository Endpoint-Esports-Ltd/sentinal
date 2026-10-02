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
import { runWorktreeSetup, type WorktreeSetupResult } from "./setup.js";
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
    maxActive: maxActiveFromEnv(base.maxActive),
    sharedResourcesFor: (worktreePath) =>
      loadRuntimeConfig(worktreePath).sharedResources,
    stopOwnedRuntime: (worktreePath) => stopOwnedGroup(worktreePath),
    ownsLiveRuntime: (worktreePath) => ownsLiveRuntime(worktreePath),
    // ⛔ The seeding path is the one that writes CREDENTIALS config, and until
    // now it was the only interpolated surface the typo check never reached.
    unknownSentinalTokens: (text) => unknownSentinalTokens(text),
    runSetup: (worktreePath, slot) => runSetupFor(worktreePath, slot),
  };
}

/**
 * The once-per-worktree `setup` (orca D5): the WORKTREE's own contract (its
 * checked-out copy, interpolated for its slot), run by `runWorktreeSetup`.
 * Never throws. An absent contract, or one without `setup`, is an inert
 * success; a contract that exists but cannot be used is reported as a failed
 * setup rather than skipped silently — its `setup` may be exactly what the
 * worktree needs.
 */
async function runSetupFor(
  worktreePath: string,
  slot: number | null,
): Promise<WorktreeSetupResult> {
  const loaded = loadRuntimeConfig(worktreePath);
  if (loaded.error) {
    return {
      ran: false,
      ok: false,
      exitCode: null,
      timedOut: false,
      tail: "",
      reason: `${loaded.relPath} could not be used, so setup was not run: ${loaded.error}`,
    };
  }
  return runWorktreeSetup(worktreePath, loaded.config, { slot });
}

/**
 * `SENTINAL_WORKTREE_MAX_ACTIVE`: how many worktrees Sentinal holds at once
 * (default 5 — e.g. an Orca wave of 8 phases runs in batches). Only a positive
 * integer counts; anything else keeps the default. More slots mean more
 * per-slot ports / database names for a runtime.json contract.
 */
function maxActiveFromEnv(fallback: number): number {
  const raw = process.env.SENTINAL_WORKTREE_MAX_ACTIVE?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 1 ? n : fallback;
}
