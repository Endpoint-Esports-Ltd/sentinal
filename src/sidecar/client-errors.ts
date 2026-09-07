/**
 * Sidecar Failure Classification (issue #9)
 *
 * Splits a failed sidecar request into the two cases that demand OPPOSITE
 * responses from the caller:
 *
 *   1. CONNECT failure — the request never reached the server. Nothing ran.
 *      Retrying is always safe. Wording is unchanged from the original
 *      `enrich()` and is asserted verbatim by `client.test.ts`.
 *
 *   2. READ TIMEOUT — the server WAS reached and simply did not answer within
 *      the budget. The operation may still be running, may have completed, or
 *      may have failed. The outcome is genuinely UNKNOWN.
 *
 * ⛔ Conflating these is not a cosmetic defect. A destructive
 * `worktree_cleanup` that had already deleted 7 worktrees and freed 6.3 GB
 * reported "sidecar ... unreachable", which reads as "nothing happened" — so
 * the caller retried. For `cleanup` a retry is harmless; the same client path
 * fronts `sync` (squash merge) and `abandon`, where it is not.
 *
 * ⛔ Lives OUTSIDE client.ts on purpose. client.ts is hook-reachable and must
 * stay dependency-light (same rule as utils/file-log.ts), and it was already at
 * 346/400 lines. This module imports nothing.
 */

/**
 * Routes whose work cannot be blindly repeated. A timeout on one of these must
 * tell the caller to reconcile real state before retrying.
 *
 * `/worktree/sync` has no sidecar route today (squash-merge runs direct), but
 * it is listed so that wiring one later cannot silently miss this warning.
 */
export const DESTRUCTIVE_PATHS = [
  "/worktree/cleanup",
  "/worktree/sync",
  "/worktree/abandon",
] as const;

/**
 * Is this rejection a client-side read timeout?
 *
 * Bun's `AbortSignal.timeout` rejects `fetch` with a DOMException carrying
 * `name === "TimeoutError"` (message "The operation timed out.", legacy `code`
 * 23 === DOMException.TIMEOUT_ERR — the "(23)" in the reported error).
 *
 * ⛔ Match on `name`, never on the message: the message is a runtime detail and
 * differs across Bun/Node/undici, whereas `name` is fixed by the DOM spec.
 * `client.ts` already uses this exact predicate to decide retry-safety.
 */
export function isTimeoutFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/** Does this path front an operation that must not be blindly repeated? */
function isDestructive(path: string): boolean {
  return DESTRUCTIVE_PATHS.some((p) => path.startsWith(p));
}

/**
 * Build the caller-facing error for a failed sidecar request.
 *
 * @param budgetMs the timeout budget that was applied, so the message can say
 *   what was actually waited for rather than leaving the caller to guess.
 */
export function classifySidecarFailure(
  err: unknown,
  method: string,
  path: string,
  target: string,
  budgetMs: number,
): Error {
  const cause = err instanceof Error ? err.message : String(err);

  if (isTimeoutFailure(err)) {
    const reconcile = isDestructive(path)
      ? " This endpoint is DESTRUCTIVE: reconcile real state " +
        "(`git worktree list`, `git branch`) before retrying — a blind retry " +
        "may double-execute work that already landed."
      : "";
    return new Error(
      `${method} ${path} timed out after ${budgetMs}ms — OUTCOME UNKNOWN. ` +
        `The sidecar at ${target} was reached but did not respond in time, so ` +
        `the operation may still be running, or may have already completed. ` +
        `This is a client read timeout, not a connection failure. ` +
        `Raise the budget with SENTINAL_SIDECAR_TIMEOUT_MS if the work is ` +
        `expected to be slow.${reconcile}`,
    );
  }

  // Connect failure — preserved byte-for-byte from the original `enrich()`.
  const code =
    err instanceof Error && "code" in err
      ? ` (${(err as { code?: string }).code})`
      : "";
  return new Error(
    `${method} ${path} failed: sidecar at ${target} unreachable — ${cause}${code}`,
  );
}
