/**
 * MCP Tool Runtime Helpers
 *
 * Small, dependency-free helpers that let MCP tool handlers honor client
 * cancellation (`extra.signal`) and emit progress (`extra.sendNotification`),
 * using the @modelcontextprotocol/sdk `RequestHandlerExtra` surface.
 *
 * Both are additive and fail-safe:
 * - `withAbort` rejects promptly on abort without waiting for the underlying
 *   promise to settle; when no signal is provided it passes through unchanged.
 * - `emitProgress` is best-effort: a no-op when no progressToken is present,
 *   and never throws (progress is non-critical).
 */

// ── Types (structural subsets of the SDK's RequestHandlerExtra) ──────────────

/** Minimal subset of RequestHandlerExtra used for progress emission. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: unknown) => Promise<void>;
}

export interface ProgressUpdate {
  /** Monotonic progress value. */
  progress: number;
  /** Optional total for a determinate bar. */
  total?: number;
  /** Optional human-readable message. */
  message?: string;
}

// ── Abort ────────────────────────────────────────────────────────────────────

/**
 * Race a promise against an AbortSignal. Rejects promptly with an abort error
 * the moment the signal fires — it does NOT wait for `promise` to settle.
 *
 * When `signal` is undefined, returns `promise` unchanged (pass-through).
 */
export function withAbort<T>(
  signal: AbortSignal | undefined,
  promise: Promise<T>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function abortError(): Error {
  const err = new Error("Operation aborted by client");
  err.name = "AbortError";
  return err;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Emit an MCP `notifications/progress` message tied to the current request.
 *
 * Best-effort:
 * - no-op when `extra` is undefined or no `progressToken` was supplied by the client
 * - never throws (swallows transport errors) — progress is non-critical
 */
export async function emitProgress(
  extra: ProgressExtra | undefined,
  update: ProgressUpdate,
): Promise<void> {
  const progressToken = extra?._meta?.progressToken;
  if (!extra || progressToken === undefined) return;

  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: update.progress,
        ...(update.total !== undefined && { total: update.total }),
        ...(update.message !== undefined && { message: update.message }),
      },
    });
  } catch {
    // Progress is best-effort — never let it break the tool call.
  }
}
