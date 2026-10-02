/**
 * `startTask` for the Orca dispatch engine (D7), plus the helpers every
 * dispatch mutation shares. Split from `dispatch.ts` for length; `dispatch.ts`
 * re-exports the public API, so import from there.
 *
 * Start: optional auth preflight (`agentAuth`, refuse on `ok === false`) →
 * `worker-start` → on `failed`, release the attempt (residual terminals are
 * reported, never closed) and make exactly ONE `--retry-of` with explicit
 * placement. `task_not_startable` is `blocked` (not an error);
 * `outcome_unknown` is returned untouched. A caller's `retryOf` (replacing a
 * stopped/failed attempt) goes on the FIRST `worker-start` together with its
 * `--retry-request`, so a pending replay still works.
 *
 * Pre-warmed start (issue #13): for agents in `prewarmAgents` the agent
 * terminal is created and waited on first (`dispatch-prewarm.ts`), then
 * `worker-start --terminal <h>` (never with `--agent`). If the input box never
 * appears, Sentinal closes ITS terminal and falls back to `--agent`. A replay
 * with no local record never pre-warms: `request-show` decides.
 */

import { randomUUID } from "node:crypto";
import type { OrcaError } from "./cli.js";
import { agentAuth, type AgentAuth } from "./detect.js";
import type { OrcaWorkerStartReceipt } from "./types.js";

export {
  err,
  mutate,
  pathFromId,
  type Base,
  type Failure,
  type Ok,
} from "./dispatch-core.js";
import { err as failure, mutate, type Base } from "./dispatch-core.js";
import {
  closeTerminal,
  prewarmTerminal,
  requestOutcome,
  usePrewarm,
  type PrewarmClock,
} from "./dispatch-prewarm.js";
import {
  cleanupAttempt,
  deliveryConfirmed,
  retryPlacement,
  type FailedAttempt,
  type Placement,
} from "./dispatch-attempts.js";
export type {
  AttemptCleanup,
  FailedAttempt,
  Placement,
} from "./dispatch-attempts.js";

// --------------------------------------------------------------- Start task

export type StartTaskResult =
  | {
      status: "started";
      dispatchId: string;
      receipt: OrcaWorkerStartReceipt;
      requestId: string;
      retried: boolean;
      /** False when Orca cannot observe the prompt landing (`unsupported`). */
      deliveryConfirmed: boolean;
      failedAttempts: FailedAttempt[];
      startPath: StartPath;
      /** The terminal Sentinal created and started the worker in. */
      prewarm?: { terminal: string; readyMs?: number };
      /** Why a pre-warm fell back to `--agent`. */
      fallbackReason?: string;
      /** The caller's `retry_of` was refused for a `ready` task; started plainly. */
      retrySkipped?: true;
      retrySkipMessage?: string;
    }
  | {
      status: "blocked";
      taskId: string;
      unmetDependencies: string[];
      taskStatus?: string;
      message: string;
      requestId: string;
    }
  | {
      status: "outcome_unknown";
      receipt: OrcaWorkerStartReceipt;
      requestId: string;
      failedAttempts: FailedAttempt[];
    }
  | { status: "refused"; auth: AgentAuth; message: string }
  | { status: "failed"; message: string; attempts: FailedAttempt[] }
  | {
      status: "error";
      error: OrcaError;
      requestId?: string;
      failedAttempts: FailedAttempt[];
    };

export type StartPath = "prewarmed" | "agent" | "agent-fallback" | "replayed";

export interface StartTaskOptions extends Base {
  taskId: string;
  worktree: Placement;
  agent: string;
  name?: string;
  baseBranch?: string;
  runId?: string;
  /** Auth preflight via `agentAuth` (default true). */
  preflight?: boolean;
  /** Runner deadline for one `worker-start` (Orca's own readiness wait is ~60 s). */
  timeoutMs?: number;
  /** Dispatch id of a stopped/failed attempt this start replaces (`--retry-of`). */
  retryOf?: string;
  /** Agents to pre-warm (the MCP layer resolves the env; default none here). */
  prewarmAgents?: readonly string[];
  /** A terminal this request already pre-warmed (in-process replay). */
  terminal?: string;
  /** A replay of `requestId` this process has no record of (restart). */
  replay?: boolean;
  /** Called as soon as a pre-warm terminal exists (to track it across joins). */
  onTerminalCreated?: (handle: string) => void;
  /** Called whenever Sentinal closes a terminal it created (stop tracking it). */
  onTerminalClosed?: (handle: string) => void;
  /** Called with the request id of the plain start after a skipped `retry_of`. */
  onRetrySkipped?: (requestId: string) => void;
  /** Replay of an earlier skip: start plainly under this request id. */
  skipRequestId?: string;
  prewarmTimeoutMs?: number;
  /** Pre-warm launch command (e.g. with an inline OpenCode config). */
  launchCommand?: string;
  /** Tests: an instant clock for the readiness poll. */
  prewarmClock?: PrewarmClock;
}

const START_TIMEOUT_MS = 75_000;

function placementArgs(p: Placement, o: StartTaskOptions): string[] {
  if (typeof p === "object") return ["--worktree", `path:${p.path}`];
  if (p === "current") return ["--worktree", "current"];
  const args = ["--worktree", "new-child"];
  if (o.name) args.push("--name", o.name);
  if (o.baseBranch) args.push("--base-branch", o.baseBranch);
  return args;
}

/**
 * One `worker-start`. The first attempt carries the caller's `retryOf` (if
 * any) AND its request id, so a pending replay still works; the automatic
 * retry (`auto`) retries the failed attempt's dispatch with a fresh request id.
 */
async function startOnce(
  o: StartTaskOptions,
  placement: Placement,
  auto?: string,
  terminal?: string,
) {
  const retryOf = auto ?? o.retryOf;
  const args = ["worker-start", "--task", o.taskId];
  if (o.runId) args.push("--run", o.runId);
  args.push(...placementArgs(placement, o));
  args.push(...(terminal ? ["--terminal", terminal] : ["--agent", o.agent]));
  if (retryOf) args.push("--retry-of", retryOf);
  return mutate<OrcaWorkerStartReceipt>(args, {
    runner: o.runner,
    requestId: auto ? undefined : o.requestId,
    timeoutMs: o.timeoutMs ?? START_TIMEOUT_MS,
  });
}

export async function startTask(o: StartTaskOptions): Promise<StartTaskResult> {
  if (o.preflight !== false) {
    const auth = await agentAuth(o.agent, { runner: o.runner });
    if (!auth.ok) {
      return {
        status: "refused",
        auth,
        message: `${auth.agent} cannot start: ${auth.detail} (${auth.reason}). Use --agent opencode, or run /login for ${auth.agent} and retry.`,
      };
    }
  }

  const prewarm = usePrewarm(o.agent, o.worktree, o.prewarmAgents ?? []);
  if (prewarm && o.replay && !o.terminal && o.requestId) {
    return replayWithoutRecord(o.requestId, o);
  }

  const failedAttempts: FailedAttempt[] = [];
  let opts: StartTaskOptions = o.skipRequestId
    ? { ...o, retryOf: undefined, requestId: o.skipRequestId }
    : o;
  let skip: { message: string } | undefined = o.skipRequestId
    ? { message: "retry_of skipped earlier (task already ready)" }
    : undefined;
  const close = async (h: string) => {
    const c = await closeTerminal(h, o.runner);
    o.onTerminalClosed?.(h);
    return c;
  };
  let placement = o.worktree;
  let retryOf: string | undefined;
  let terminal = prewarm ? o.terminal : undefined;
  let path: StartPath = "agent";
  let readyMs: number | undefined;
  let fallbackReason: string | undefined;
  for (;;) {
    if (prewarm && !terminal && path !== "agent-fallback") {
      const w = await prewarmTerminal({
        placement,
        agent: o.agent,
        command: o.launchCommand,
        taskId: o.taskId,
        runner: o.runner,
        timeoutMs: o.prewarmTimeoutMs,
        onCreated: o.onTerminalCreated,
        ...o.prewarmClock,
      });
      if (w.ok) {
        terminal = w.handle;
        readyMs = w.readyMs;
      } else {
        if (w.handle) await close(w.handle);
        path = "agent-fallback";
        fallbackReason = w.reason;
      }
    }
    if (terminal) path = "prewarmed";
    const r = await startOnce(opts, placement, retryOf, terminal);
    if (!r.ok) {
      const data = r.error.data ?? {};
      if (!skip && !retryOf && readyAgain(opts, r.error.code, data)) {
        // The caller's retry_of is refused because its attempt already
        // settled and the task is `ready`: start it plainly, once, reusing
        // any pre-warmed terminal (worker-start never took it).
        skip = { message: r.error.message };
        const id = randomUUID();
        o.onRetrySkipped?.(id);
        opts = { ...opts, retryOf: undefined, requestId: id };
        continue;
      }
      // Close only on a structured Orca refusal: a timeout, a missing CLI or
      // unparsable output does not prove Orca did not take the terminal.
      if (terminal && !ADAPTER_CODES.has(r.error.code)) await close(terminal);
      if (r.error.code === "task_not_startable" && !retryOf) {
        const unmet = Array.isArray(data.unmetDependencies)
          ? data.unmetDependencies.filter(
              (d): d is string => typeof d === "string",
            )
          : [];
        return {
          status: "blocked",
          taskId: o.taskId,
          unmetDependencies: unmet,
          ...(typeof data.status === "string"
            ? { taskStatus: data.status }
            : {}),
          message: r.error.message,
          requestId: r.requestId ?? "",
        };
      }
      return {
        status: "error",
        error: r.error,
        requestId: r.requestId,
        failedAttempts,
      };
    }
    const receipt = r.result;
    if (receipt?.state === "ready") {
      return {
        status: "started",
        dispatchId: receipt.dispatchId,
        receipt,
        requestId: r.requestId,
        retried: retryOf !== undefined,
        deliveryConfirmed: deliveryConfirmed(receipt),
        failedAttempts,
        startPath: path,
        ...(terminal ? { prewarm: { terminal, readyMs } } : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
        ...(skip
          ? { retrySkipped: true as const, retrySkipMessage: skip.message }
          : {}),
      };
    }
    if (receipt?.state !== "failed") {
      // outcome_unknown or anything unrecognised: inspect, never retry blind.
      return {
        status: "outcome_unknown",
        receipt,
        requestId: r.requestId,
        failedAttempts,
      };
    }
    const cleanup = await cleanupAttempt(receipt, o.runner);
    if (terminal) await settleOwnTerminal(terminal, cleanup, close);
    failedAttempts.push({ receipt, cleanup });
    if (retryOf) {
      const why = failedAttempts
        .map((a) =>
          `${a.receipt.dispatchId}: ${a.receipt.failedStage ?? a.receipt.stage} ${a.receipt.lastError ?? ""}`.trim(),
        )
        .join("; ");
      return {
        status: "failed",
        message: `worker-start failed twice for ${o.taskId} (${why})`,
        attempts: failedAttempts,
      };
    }
    placement = retryPlacement(o.worktree, receipt);
    retryOf = receipt.dispatchId;
    terminal = undefined;
    readyMs = undefined;
  }
}

/** Errors the CLI adapter raises itself — never proof Orca refused the start. */
const ADAPTER_CODES = new Set([
  "orca_timeout",
  "orca_unavailable",
  "orca_bad_output",
]);

/** `task_not_startable` for a caller's `retry_of` on a task that is `ready`. */
function readyAgain(
  o: StartTaskOptions,
  code: string,
  data: Record<string, unknown>,
): boolean {
  const unmet = Array.isArray(data.unmetDependencies)
    ? data.unmetDependencies
    : [];
  return (
    !!o.retryOf &&
    code === "task_not_startable" &&
    data.status === "ready" &&
    unmet.length === 0
  );
}

/**
 * Our terminal after a failed attempt: closed only once the release settled
 * (`released`/`already_released`/`retained`, or nothing to release) —
 * after `release_pending`/`release_unknown`/an error it is only reported.
 */
async function settleOwnTerminal(
  terminal: string,
  cleanup: FailedAttempt["cleanup"],
  close: (h: string) => Promise<{ ok: true } | { ok: false; message: string }>,
): Promise<void> {
  const settled = [
    "released",
    "already_released",
    "retained",
    "not_needed",
  ].includes(cleanup.release);
  if (!settled) {
    cleanup.unclosedTerminals.push({
      id: terminal,
      reason: `Sentinal-created; release ${cleanup.release}`,
    });
    return;
  }
  const c = await close(terminal);
  if (c.ok) cleanup.closedTerminals.push(terminal);
  else cleanup.unclosedTerminals.push({ id: terminal, reason: c.message });
}

/** A restart lost the local record: ask Orca, never start a second worker. */
async function replayWithoutRecord(
  requestId: string,
  o: StartTaskOptions,
): Promise<StartTaskResult> {
  const r = await requestOutcome(requestId, o.runner);
  const receipt = r.receipt as OrcaWorkerStartReceipt | undefined;
  if (r.state === "completed" && receipt?.state === "ready") {
    return {
      status: "started",
      dispatchId: receipt.dispatchId,
      receipt,
      requestId,
      retried: false,
      deliveryConfirmed: deliveryConfirmed(receipt),
      failedAttempts: [],
      startPath: "replayed",
    };
  }
  if (r.state === "pending") {
    const e = failure("orca_timeout", "the start is still pending in Orca");
    return { status: "error", error: e.error, requestId, failedAttempts: [] };
  }
  const e = failure(
    "start_outcome_unknown",
    `request ${requestId} is ${r.state} in Orca (${r.interpretation ?? ""}). Inspect with orca orchestration worker-list --run <run> before starting again; nothing was started.`,
  );
  return { status: "error", error: e.error, requestId, failedAttempts: [] };
}
