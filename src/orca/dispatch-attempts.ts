/**
 * Failed-attempt handling for `startTask` (split from `dispatch-start.ts` for
 * length): release what the attempt left behind, and where to retry.
 */

import type { OrcaRunner } from "./cli.js";
import { mutate, pathFromId } from "./dispatch-core.js";
import type {
  OrcaWorkerReleaseResult,
  OrcaWorkerStartReceipt,
} from "./types.js";

export type Placement = "current" | "new-child" | { path: string };

export interface AttemptCleanup {
  release: OrcaWorkerReleaseResult["state"] | "error" | "not_needed";
  /** Only terminals SENTINAL created (pre-warm) — never one Orca owns. */
  closedTerminals: string[];
  unclosedTerminals: Array<{ id: string; reason: string }>;
  /** Worktrees the attempt created; never removed here. */
  residualWorktrees: string[];
  recovery?: string;
}

export interface FailedAttempt {
  receipt: OrcaWorkerStartReceipt;
  cleanup: AttemptCleanup;
}

/**
 * Settle what a failed attempt left behind: `worker-release` its dispatch.
 * Orca's recovery guide says never substitute `terminal close` for release, so
 * when the release answers anything but released/already_released (`retained`,
 * e.g. `user_takeover` / `external_terminal`, or the uncertain
 * `release_pending`/`release_unknown`) every residual terminal is REPORTED in
 * `unclosedTerminals` with Orca's `recovery` text — never closed.
 */
export async function cleanupAttempt(
  receipt: OrcaWorkerStartReceipt,
  runner?: OrcaRunner,
): Promise<AttemptCleanup> {
  const residual = Array.isArray(receipt.residualResources)
    ? receipt.residualResources
    : [];
  const terminals = residual
    .filter((r) => r?.kind === "terminal" && typeof r.id === "string")
    .map((r) => r.id as string);
  const cleanup: AttemptCleanup = {
    release: "not_needed",
    closedTerminals: [],
    unclosedTerminals: [],
    residualWorktrees: residual
      .filter((r) => r?.kind === "worktree" && typeof r.id === "string")
      .map((r) => r.id as string),
  };
  if (terminals.length === 0) return cleanup;

  const rel = await mutate<OrcaWorkerReleaseResult>(
    ["worker-release", "--dispatch", receipt.dispatchId],
    { runner },
  );
  const state = rel.ok ? (rel.result?.state ?? "error") : "error";
  cleanup.release = state;
  const recovery = rel.ok ? rel.result?.recovery : rel.error.message;
  if (recovery) cleanup.recovery = recovery;
  if (state === "released" || state === "already_released") return cleanup;

  const reason =
    state === "retained"
      ? `retained: ${(rel.ok ? rel.result?.reason : undefined) || state}`
      : `release ${state}`;
  for (const id of terminals) cleanup.unclosedTerminals.push({ id, reason });
  return cleanup;
}

/** Orca says `unsupported` when it cannot observe the prompt landing. */
export const deliveryConfirmed = (r: OrcaWorkerStartReceipt): boolean =>
  r.turnStart !== "unsupported" && r.prompt?.observation !== "unsupported";

/** Retry placement: a failed `new-child` start reuses the child it created (S5). */
export function retryPlacement(
  p: Placement,
  failed: OrcaWorkerStartReceipt,
): Placement {
  if (p !== "new-child") return p;
  const child = (failed.residualResources ?? []).find(
    (r) => r?.kind === "worktree" && r.action === "created_child",
  );
  const path = pathFromId(typeof child?.id === "string" ? child.id : undefined);
  return path ? { path } : p;
}
