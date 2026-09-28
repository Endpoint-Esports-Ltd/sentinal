/**
 * The Orca dispatch engine (D7/D8): bind a Run, create Tasks, prepare child
 * worktrees, start workers (`startTask`, in `dispatch-start.ts`), wait for
 * settlement with stall verdicts, and stop/release/remove. Every function
 * returns a typed result and never throws.
 *
 * Every orchestration mutation carries a UUID `--retry-request` (Orca requires
 * the UUID form) that is returned to the caller, so a lost response can be
 * replayed by passing it back as `requestId` instead of re-applying the
 * mutation. `worktree`/`terminal` commands accept no such flag.
 *
 * ⛔ Absence never authorizes action: `outcome_unknown` is returned as-is, and
 * `stopWorker` refuses without a positive `StallVerdict`.
 */

import { runOrca, type OrcaError, type OrcaRunner } from "./cli.js";
import {
  err,
  mutate,
  pathFromId,
  type Base,
  type Failure,
  type Ok,
} from "./dispatch-start.js";
import { collectStalls, type StallVerdict } from "./stall.js";
import type {
  OrcaCheckResult,
  OrcaMessage,
  OrcaRun,
  OrcaRunCreateResult,
  OrcaRunCurrentResult,
  OrcaTask,
  OrcaTaskCreateResult,
  OrcaWorkerDonePayload,
  OrcaWorkerReleaseResult,
  OrcaWorkerStopResult,
  OrcaWorktreeResult,
} from "./types.js";

export {
  startTask,
  type AttemptCleanup,
  type Failure,
  type FailedAttempt,
  type Placement,
  type StartTaskOptions,
  type StartTaskResult,
} from "./dispatch-start.js";

// ------------------------------------------------------------ Run and Task

/**
 * Reuse the Run bound to the coordinator terminal only when its
 * `coordinator_handle` is the expected one (Pre-Mortem 3); otherwise refuse.
 * With nothing bound, `run-create`.
 */
export async function ensureRun(
  o: Base & {
    objective: string;
    coordinatorHandle?: string;
    env?: Record<string, string | undefined>;
    /**
     * Resume an existing Run (e.g. a master plan continued in a new session):
     * a Run is bound to ONE coordinator terminal, so a new terminal must
     * `run-use` it before it can read its mailbox.
     */
    runId?: string;
  },
): Promise<
  Ok<{ run: OrcaRun; reused: boolean; requestId?: string }> | Failure
> {
  const expected =
    o.coordinatorHandle?.trim() ||
    (o.env ?? process.env).ORCA_TERMINAL_HANDLE?.trim();
  if (!expected) {
    return err(
      "no_coordinator_handle",
      "No coordinator handle: ORCA_TERMINAL_HANDLE is unset and none was given",
    );
  }
  const from = o.coordinatorHandle ? ["--from", expected] : [];
  const mismatch = (run: OrcaRun, requestId?: string) => ({
    ...err(
      "coordinator_mismatch",
      `Run ${run.id} is coordinated by ${run.coordinator_handle}, not ${expected}; refusing to use it`,
      requestId,
    ),
    run,
  });

  const cur = await runOrca<OrcaRunCurrentResult>(
    ["orchestration", "run-current", ...from],
    { runner: o.runner },
  );
  if (!cur.ok) return { ok: false, error: cur.error };
  const bound = cur.result?.run;
  if (bound) {
    if (o.runId && bound.id !== o.runId) {
      return err(
        "run_mismatch",
        `This terminal is bound to Run ${bound.id}, not ${o.runId}; refusing to switch Runs silently`,
      );
    }
    return bound.coordinator_handle === expected
      ? { ok: true, run: bound, reused: true }
      : mismatch(bound);
  }
  if (o.runId) {
    const used = await mutate<OrcaRunCreateResult>(
      ["run-use", "--id", o.runId, ...from],
      o,
    );
    if (!used.ok) return used;
    const run = used.result?.run;
    if (!run?.id) {
      return err("orca_bad_output", "run-use returned no run", used.requestId);
    }
    if (run.coordinator_handle !== expected) {
      return mismatch(run, used.requestId);
    }
    return { ok: true, run, reused: true, requestId: used.requestId };
  }
  const made = await mutate<OrcaRunCreateResult>(
    ["run-create", "--objective", o.objective, ...from],
    o,
  );
  if (!made.ok) return made;
  const run = made.result?.run;
  if (!run?.id) {
    return err("orca_bad_output", "run-create returned no run", made.requestId);
  }
  if (run.coordinator_handle !== expected) return mismatch(run, made.requestId);
  return { ok: true, run, reused: false, requestId: made.requestId };
}

export async function createTask(
  o: Base & { runId: string; title: string; spec: string; deps?: string[] },
): Promise<Ok<{ task: OrcaTask; requestId: string }> | Failure> {
  const args = ["task-create", "--run", o.runId, "--spec", o.spec];
  args.push("--task-title", o.title);
  if (o.deps?.length) args.push("--deps", JSON.stringify(o.deps));
  const r = await mutate<OrcaTaskCreateResult>(args, o);
  if (!r.ok) return r;
  const task = r.result?.task;
  if (!task?.id) {
    return err("orca_bad_output", "task-create returned no task", r.requestId);
  }
  return { ok: true, task, requestId: r.requestId };
}

// ---------------------------------------------------------------- Worktrees

function worktreeOf(result: unknown) {
  const wt = (result as OrcaWorktreeResult | undefined)?.worktree;
  const path = wt?.path ?? pathFromId(wt?.id);
  if (!path) return null;
  return {
    path,
    worktreeId: wt?.id ?? null,
    ...(wt?.branch ? { branch: wt.branch } : {}),
  };
}

/**
 * `orca worktree create --setup skip` with NO agent (D8): Sentinal adopts and
 * sets it up before any worker starts. Falls back to `worktree show` by name
 * when the create result carries no path.
 */
export async function prepareChildWorktree(o: {
  name: string;
  baseBranch: string;
  parent?: string;
  runner?: OrcaRunner;
}): Promise<
  Ok<{ path: string; worktreeId: string | null; branch?: string }> | Failure
> {
  const created = await runOrca(
    [
      "worktree",
      "create",
      "--name",
      o.name,
      "--base-branch",
      o.baseBranch,
      "--parent-worktree",
      o.parent ?? "current",
      "--setup",
      "skip",
    ],
    { runner: o.runner },
  );
  if (!created.ok) return { ok: false, error: created.error };
  const wt = worktreeOf(created.result);
  if (wt) return { ok: true, ...wt };

  const shown = await runOrca(
    ["worktree", "show", "--worktree", `name:${o.name}`],
    { runner: o.runner },
  );
  const again = shown.ok ? worktreeOf(shown.result) : null;
  if (again) return { ok: true, ...again };
  return err(
    "orca_bad_output",
    `worktree create for ${o.name} returned no path, and worktree show could not resolve it`,
  );
}

export async function removeChildWorktree(
  path: string,
  o: { force?: boolean; runner?: OrcaRunner } = {},
): Promise<Ok<{ result: unknown }> | Failure> {
  const args = ["worktree", "rm", "--worktree", `path:${path}`];
  if (o.force) args.push("--force");
  const r = await runOrca(args, { runner: o.runner });
  return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
}

// ------------------------------------------------------------- Settlement

export const DEFAULT_WAIT_MS = 35_000;
/** Below the MCP SDK's 60 s request timeout. */
export const MAX_WAIT_MS = 40_000;
const WAIT_SLACK_MS = 5_000;

export interface SettledMessage extends Omit<OrcaMessage, "payload"> {
  payload: Record<string, unknown> | null;
  rawPayload: string | null;
  workerDone: OrcaWorkerDonePayload | null;
}

function decode(m: OrcaMessage): SettledMessage {
  let payload: Record<string, unknown> | null = null;
  if (typeof m.payload === "string") {
    try {
      const v: unknown = JSON.parse(m.payload);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        payload = v as Record<string, unknown>;
      }
    } catch {
      /* keep rawPayload only */
    }
  }
  const workerDone =
    m.type === "worker_done" && typeof payload?.dispatchId === "string"
      ? (payload as unknown as OrcaWorkerDonePayload)
      : null;
  return { ...m, payload, rawPayload: m.payload ?? null, workerDone };
}

/**
 * One bounded `check --wait`. `timedOut: true` is a checkpoint — call again.
 * Stall verdicts cover every still-active dispatch of the Run except those
 * whose `worker_done` is in this batch.
 */
export async function waitForSettlement(o: {
  runId: string;
  timeoutMs?: number;
  runner?: OrcaRunner;
  now?: number;
  maxIdleMs?: number;
}): Promise<
  | Ok<{
      timedOut: boolean;
      deliveryId: string | null;
      messages: SettledMessage[];
      stalls: StallVerdict[];
      verdicts: StallVerdict[];
      stallError?: OrcaError;
    }>
  | Failure
> {
  const wait = Math.min(
    Math.max(o.timeoutMs ?? DEFAULT_WAIT_MS, 1_000),
    MAX_WAIT_MS,
  );
  const r = await runOrca<OrcaCheckResult>(
    ["orchestration", "check", "--run", o.runId, "--wait"]
      .concat(["--types", "worker_done,escalation,question"])
      .concat(["--timeout-ms", String(wait)]),
    { runner: o.runner, timeoutMs: wait + WAIT_SLACK_MS },
  );
  if (!r.ok) return { ok: false, error: r.error };
  const messages = (
    Array.isArray(r.result?.messages) ? r.result.messages : []
  ).map(decode);
  const settled = messages.flatMap((m) =>
    m.workerDone ? [m.workerDone.dispatchId] : [],
  );
  const s = await collectStalls({
    runId: o.runId,
    runner: o.runner,
    now: o.now,
    maxIdleMs: o.maxIdleMs,
    settledDispatchIds: settled,
  });
  return {
    ok: true,
    timedOut: r.result?.timedOut === true,
    deliveryId: r.result?.deliveryId ?? null,
    messages,
    stalls: s.ok ? s.stalls : [],
    verdicts: s.ok ? s.verdicts : [],
    ...(s.ok ? {} : { stallError: s.error }),
  };
}

/** Acknowledge a processed Delivery (returns the next batch, which replays until acked). */
export async function ackDelivery(
  o: Base & { runId: string; deliveryId: string },
): Promise<Ok<{ result: OrcaCheckResult; requestId: string }> | Failure> {
  const r = await mutate<OrcaCheckResult>(
    ["check", "--run", o.runId, "--ack", o.deliveryId],
    o,
  );
  return r.ok ? { ok: true, result: r.result, requestId: r.requestId } : r;
}

// ------------------------------------------------------ Stop and release

/** Refuses unless `evidence` is a positive stall verdict for this dispatch. */
export async function stopWorker(
  dispatchId: string,
  o: Base & { evidence: StallVerdict },
): Promise<Ok<{ result: OrcaWorkerStopResult; requestId: string }> | Failure> {
  const e = o.evidence;
  if (
    !e ||
    e.stalled !== true ||
    !e.reason ||
    (e.dispatchId !== null && e.dispatchId !== dispatchId)
  ) {
    return err(
      "stop_refused",
      `Refusing to stop ${dispatchId}: no positive stall evidence for it (absence never authorizes a stop)`,
    );
  }
  const r = await mutate<OrcaWorkerStopResult>(
    ["worker-stop", "--dispatch", dispatchId],
    o,
  );
  if (!r.ok) return r;
  if (r.result?.state === "stop_unknown") {
    return err(
      "stop_unknown",
      `worker-stop could not prove ${dispatchId} stopped: ${r.result.lastError ?? ""}`.trim(),
      r.requestId,
    );
  }
  return { ok: true, result: r.result, requestId: r.requestId };
}

/** Post-settlement release. `release_unknown` is an error carrying Orca's recovery text. */
export async function releaseWorker(
  dispatchId: string,
  o: Base = {},
): Promise<
  Ok<{ result: OrcaWorkerReleaseResult; requestId: string }> | Failure
> {
  const r = await mutate<OrcaWorkerReleaseResult>(
    ["worker-release", "--dispatch", dispatchId],
    o,
  );
  if (!r.ok) return r;
  if (r.result?.state === "release_unknown") {
    return err(
      "release_unknown",
      `release of ${dispatchId} is unknown: ${r.result.recovery ?? r.result.lastError ?? "inspect with worker-list"}`,
      r.requestId,
    );
  }
  return { ok: true, result: r.result, requestId: r.requestId };
}
