/**
 * `startTask` for the Orca dispatch engine (D7), plus the helpers every
 * dispatch mutation shares. Split from `dispatch.ts` for length; `dispatch.ts`
 * re-exports the public API, so import from there.
 *
 * Start: optional auth preflight (`agentAuth`, refuse on `ok === false`) →
 * `worker-start` → on `failed`, close the attempt's residual terminals and make
 * exactly ONE `--retry-of` with explicit placement. `task_not_startable` is
 * `blocked` (not an error); `outcome_unknown` is returned untouched.
 */

import { randomUUID } from "node:crypto";
import { runOrca, type OrcaError, type OrcaRunner } from "./cli.js";
import { agentAuth, type AgentAuth } from "./detect.js";
import type {
  OrcaWorkerReleaseResult,
  OrcaWorkerStartReceipt,
} from "./types.js";

export type Failure = { ok: false; error: OrcaError; requestId?: string };
export type Ok<T> = { ok: true } & T;

export interface Base {
  runner?: OrcaRunner;
  /** Replay a mutation whose response was lost; default a fresh UUID. */
  requestId?: string;
}

export const err = (
  code: string,
  message: string,
  requestId?: string,
): Failure => ({
  ok: false,
  error: { code, message },
  ...(requestId ? { requestId } : {}),
});

export async function mutate<T>(
  args: string[],
  o: Base & { timeoutMs?: number },
): Promise<{ ok: true; result: T; requestId: string } | Failure> {
  const requestId = o.requestId ?? randomUUID();
  const r = await runOrca<T>(
    ["orchestration", ...args, "--retry-request", requestId],
    { runner: o.runner, timeoutMs: o.timeoutMs },
  );
  return r.ok
    ? { ok: true, result: r.result, requestId }
    : { ok: false, error: r.error, requestId };
}

/** Orca worktree ids are `<repo-id>::<absolute path>`. */
export const pathFromId = (id?: string): string | undefined => {
  const i = id ? id.indexOf("::") : -1;
  return id && i !== -1 ? id.slice(i + 2) : undefined;
};

// --------------------------------------------------------------- Start task

export type Placement = "current" | "new-child" | { path: string };

export interface AttemptCleanup {
  release: OrcaWorkerReleaseResult["state"] | "error" | "not_needed";
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

export type StartTaskResult =
  | {
      status: "started";
      dispatchId: string;
      receipt: OrcaWorkerStartReceipt;
      requestId: string;
      retried: boolean;
      failedAttempts: FailedAttempt[];
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
 * Close what a failed attempt left behind: `worker-release` its dispatch, and
 * only when Orca answers `retained` (spike S5: `user_takeover` on a terminal
 * that never ran the Task) `terminal close` the exact terminals listed in its
 * `residualResources`. `release_pending`/`release_unknown` are uncertain — we
 * never substitute `terminal close` there, only report the recovery.
 */
async function cleanupAttempt(
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

  for (const id of terminals) {
    if (state !== "retained") {
      cleanup.unclosedTerminals.push({ id, reason: `release ${state}` });
      continue;
    }
    const closed = await runOrca(["terminal", "close", "--terminal", id], {
      runner,
    });
    if (closed.ok) cleanup.closedTerminals.push(id);
    else cleanup.unclosedTerminals.push({ id, reason: closed.error.message });
  }
  return cleanup;
}

/** Retry placement: a failed `new-child` start reuses the child it created (S5). */
function retryPlacement(
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

async function startOnce(
  o: StartTaskOptions,
  placement: Placement,
  retryOf?: string,
) {
  const args = ["worker-start", "--task", o.taskId];
  if (o.runId) args.push("--run", o.runId);
  args.push(...placementArgs(placement, o), "--agent", o.agent);
  if (retryOf) args.push("--retry-of", retryOf);
  return mutate<OrcaWorkerStartReceipt>(args, {
    runner: o.runner,
    requestId: retryOf ? undefined : o.requestId,
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

  const failedAttempts: FailedAttempt[] = [];
  let placement = o.worktree;
  let retryOf: string | undefined;
  for (;;) {
    const r = await startOnce(o, placement, retryOf);
    if (!r.ok) {
      const data = r.error.data ?? {};
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
        failedAttempts,
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
    failedAttempts.push({
      receipt,
      cleanup: await cleanupAttempt(receipt, o.runner),
    });
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
  }
}
