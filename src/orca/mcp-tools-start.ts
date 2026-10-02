/**
 * `orca_start` — start ONE supervised worker (registered by
 * `registerOrcaTools` in `mcp-tools.ts`; direct-only like the rest).
 *
 * ## Start / replay design
 *
 * `worker-start` can take ~60 s (Orca's own readiness wait), longer than the
 * MCP SDK's 60 s request timeout. `orca_start` therefore races `startTask`
 * against a budget (default 45 s). On expiry it answers `pending` with the
 * request id and leaves the start running in this process; calling
 * `orca_start` again with that `request_id` JOINS the in-flight start (Orca
 * sees one `worker-start`). If this process no longer has it (restart, or the
 * CLI deadline killed the client → `orca_timeout`), the same id goes to Orca
 * as `--retry-request`, which Orca replays or joins instead of starting a
 * duplicate (recovery-and-cleanup reference: "pending → replay the original
 * command with --retry-request").
 *
 * Limitation: a timeout during the ONE `--retry-of` attempt is reported as an
 * error, not `pending` — that attempt's request id cannot be replayed through
 * `startTask`, which only replays the first attempt.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { prewarmAgents } from "./dispatch-prewarm.js";
import { opencodeLaunch, workerAllowDirs } from "./worker-access.js";
import { startTask, type StartTaskResult } from "./dispatch.js";
import {
  orcaFailure,
  orcaResponse,
  type OrcaToolState,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";
/** Below the MCP SDK's 60 s request timeout, with room for the reply. */
export const DEFAULT_START_BUDGET_MS = 45_000;
const MAX_FINISHED = 50;
const TITLE = "Orca start";
const UNCONFIRMED =
  "- Orca cannot confirm this agent received the brief; orca_wait reports a never-started stall if it did not.";

function pending(requestId: string, taskId: string, retryOf?: string) {
  const same = retryOf
    ? `the same arguments (including retry_of="${retryOf}")`
    : "the same arguments";
  return orcaResponse(
    TITLE,
    [
      `- **Pending:** the worker for ${taskId} is still starting.`,
      `- Call orca_start again with ${same} and request_id=${requestId} (joins or replays; never starts a duplicate).`,
    ],
    {
      ok: true,
      status: "pending",
      task_id: taskId,
      request_id: requestId,
      ...(retryOf ? { retry_of: retryOf } : {}),
    },
  );
}

function formatStart(
  r: StartTaskResult,
  requestId: string,
  taskId: string,
  retryOf?: string,
) {
  switch (r.status) {
    case "started":
      return orcaResponse(
        TITLE,
        [
          `- **Started** ${taskId} as dispatch ${r.dispatchId}${r.retried ? " (after one retry)" : ""}`,
          ...(r.prewarm
            ? [
                `- Pre-warmed: started in Sentinal's terminal ${r.prewarm.terminal} once the agent's input box was drawn${r.prewarm.readyMs !== undefined ? ` (${r.prewarm.readyMs} ms)` : ""}.`,
              ]
            : []),
          ...(r.fallbackReason
            ? [`- Pre-warm fell back to --agent: ${r.fallbackReason}.`]
            : []),
          ...(r.retrySkipped
            ? [
                "- retry_of was refused because the task is already ready (its previous attempt settled); started it plainly.",
              ]
            : []),
          ...(r.deliveryConfirmed || r.prewarm ? [] : [UNCONFIRMED]),
          "- Next: orca_wait(run_id) until its worker_done arrives.",
        ],
        {
          ok: true,
          status: "started",
          task_id: taskId,
          dispatch_id: r.dispatchId,
          request_id: r.requestId,
          retried: r.retried,
          delivery_confirmed: r.deliveryConfirmed,
          start_path: r.startPath,
          ...(r.prewarm ? { prewarm: r.prewarm } : {}),
          ...(r.fallbackReason ? { fallback_reason: r.fallbackReason } : {}),
          ...(r.retrySkipped
            ? {
                retry_of_skipped: true,
                retry_of_refusal: r.retrySkipMessage ?? null,
              }
            : {}),
          failed_attempts: r.failedAttempts,
        },
      );
    case "blocked":
      return orcaResponse(
        TITLE,
        [
          `- **Blocked:** ${r.message}`,
          "- Call orca_start again without request_id once the dependencies reported worker_done (Orca recorded this request's refusal).",
        ],
        {
          ok: false,
          status: "blocked",
          task_id: taskId,
          unmet_dependencies: r.unmetDependencies,
          task_status: r.taskStatus ?? null,
          request_id: r.requestId,
        },
      );
    case "refused":
      return orcaResponse(TITLE, [`- **Refused:** ${r.message}`], {
        ok: false,
        status: "refused",
        task_id: taskId,
        auth: r.auth,
      });
    case "outcome_unknown":
      return orcaResponse(
        TITLE,
        [
          `- **Outcome unknown** for dispatch ${r.receipt?.dispatchId ?? "?"}: inspect (worker-show / worker-list) before choosing; never retry blind.`,
          ...(r.receipt?.recovery
            ? [`- Orca recovery: ${r.receipt.recovery}`]
            : []),
        ],
        {
          ok: false,
          status: "outcome_unknown",
          task_id: taskId,
          dispatch_id: r.receipt?.dispatchId ?? null,
          request_id: r.requestId,
          receipt: r.receipt,
        },
      );
    case "failed":
      return orcaResponse(TITLE, [`- **Failed:** ${r.message}`], {
        ok: false,
        status: "failed",
        task_id: taskId,
        attempts: r.attempts,
      });
    case "error":
      if (r.error.code === "orca_timeout" && r.failedAttempts.length === 0) {
        return pending(requestId, taskId, retryOf);
      }
      return orcaFailure(TITLE, r.error, {
        status: "error",
        task_id: taskId,
        request_id: r.requestId ?? requestId,
        failed_attempts: r.failedAttempts,
      });
  }
}

/** One `startTask` per request id in this process; late results are kept for the next call. */
function trackStart(
  state: OrcaToolState,
  requestId: string,
  run: () => Promise<StartTaskResult>,
): Promise<StartTaskResult> {
  const existing = state.inflightStarts.get(requestId);
  if (existing) return existing;
  const tracked = run()
    .catch((e): StartTaskResult => ({
      status: "error",
      error: {
        code: "orca_error",
        message: e instanceof Error ? e.message : String(e),
      },
      failedAttempts: [],
    }))
    .then((r) => {
      state.inflightStarts.delete(requestId);
      state.finishedStarts.set(requestId, r);
      while (state.finishedStarts.size > MAX_FINISHED) {
        const oldest = state.finishedStarts.keys().next().value;
        if (oldest === undefined) break;
        state.finishedStarts.delete(oldest);
      }
      return r;
    });
  state.inflightStarts.set(requestId, tracked);
  return tracked;
}

export function registerOrcaStartTool(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_start",
    `Start ONE supervised worker for an Orca task (auth preflight, one --retry-of on a failed start, residual terminals reported). Answers within ~45 s: if the worker is still starting it returns status "pending" with a request_id — call orca_start again with the same request_id to join or replay it (never a duplicate). To replace a stopped or failed attempt (after orca_stop), pass retry_of=<its dispatch id>. Agents in SENTINAL_ORCA_PREWARM_AGENTS (default opencode) are pre-warmed: Sentinal starts the agent in its own terminal and runs worker-start --terminal once the agent's input box is drawn, so the brief is not lost. ${DIRECT}`,
    {
      task_id: z.string().min(1),
      worktree: z.union([
        z.literal("current"),
        z.object({ path: z.string().min(1) }),
      ]),
      agent: z.string().min(1),
      run_id: z.string().optional(),
      request_id: z
        .string()
        .optional()
        .describe("From a previous `pending` answer; omit for a new start"),
      retry_of: z
        .string()
        .optional()
        .describe(
          "Dispatch id of a STOPPED or FAILED attempt of this task (after orca_stop): starts a replacement with a fresh capability",
        ),
    },
    async (args) => {
      const requestId = args.request_id ?? randomUUID();
      const done = state.finishedStarts.get(requestId);
      if (done) {
        state.finishedStarts.delete(requestId);
        return formatStart(done, requestId, args.task_id, args.retry_of);
      }
      // A request id this process is not running and never finished: a
      // replay after a restart (pre-warm then asks request-show instead).
      const replay =
        args.request_id !== undefined && !state.inflightStarts.has(requestId);
      const env = deps.env ?? process.env;
      const wd = deps.workerDirs?.();
      const launch = wd
        ? opencodeLaunch({
            agent: args.agent,
            worktree:
              typeof args.worktree === "object"
                ? args.worktree.path
                : wd.coordinator,
            dirs: workerAllowDirs(env, [wd.coordinator, wd.main], homedir()),
            env,
          })
        : undefined;
      const p = trackStart(state, requestId, () =>
        startTask({
          launchCommand: launch?.command,
          taskId: args.task_id,
          worktree: args.worktree,
          agent: args.agent,
          runId: args.run_id,
          retryOf: args.retry_of,
          requestId,
          runner: deps.runner,
          prewarmAgents: prewarmAgents(env),
          terminal: state.startTerminals.get(requestId),
          replay,
          onTerminalCreated: (h) => state.startTerminals.set(requestId, h),
          onTerminalClosed: (h) => {
            if (state.startTerminals.get(requestId) === h) {
              state.startTerminals.delete(requestId);
            }
          },
          onRetrySkipped: (id) => state.startSkips.set(requestId, id),
          skipRequestId: state.startSkips.get(requestId),
          ...(deps.prewarmClock ? { prewarmClock: deps.prewarmClock } : {}),
        }).then((r) => {
          if (r.status === "started" && r.prewarm) {
            state.createdTerminals.set(r.dispatchId, r.prewarm.terminal);
          }
          // Keep the handle only while a replay may still need it.
          const timedOut =
            r.status === "error" && r.error.code === "orca_timeout";
          if (!timedOut) {
            state.startTerminals.delete(requestId);
            state.startSkips.delete(requestId);
          }
          return r;
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<"pending">((resolve) => {
        timer = setTimeout(
          () => resolve("pending"),
          deps.startBudgetMs ?? DEFAULT_START_BUDGET_MS,
        );
      });
      try {
        const r = await Promise.race([p, budget]);
        if (r === "pending")
          return pending(requestId, args.task_id, args.retry_of);
        state.finishedStarts.delete(requestId);
        const res = formatStart(r, requestId, args.task_id, args.retry_of);
        return r.status === "started" && r.startPath === "prewarmed"
          ? withAccess(res, launch, args.agent)
          : res;
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

/**
 * Add `worker_access` (or why it was skipped) to a pre-warmed start's
 * response: the JSON block is re-serialised, and a line goes before Next.
 */
function withAccess(
  res: ReturnType<typeof formatStart>,
  launch: ReturnType<typeof opencodeLaunch> | undefined,
  agent: string,
): ReturnType<typeof formatStart> {
  if (!launch || agent !== "opencode") return res;
  const a = launch.access;
  const extra = {
    ...(a ? { worker_access: { dirs: a.dirs, read_only: true } } : {}),
    ...(launch.skipped ? { worker_access_skipped: launch.skipped } : {}),
    ...(launch.skippedDirs?.length
      ? { worker_access_skipped_dirs: launch.skippedDirs }
      : {}),
  };
  if (Object.keys(extra).length === 0) return res;
  const line = a
    ? `- The worker can read ${a.dirs.join(", ")} without a permission prompt (read-only).`
    : `- No directory access was granted (${launch.skipped ?? "no directories"}); the worker may still prompt.`;
  const block = res.content[0]!;
  const m = /```json\n([\s\S]*?)\n```/.exec(block.text);
  if (!m) return res;
  const json = JSON.stringify({ ...JSON.parse(m[1]!), ...extra }, null, 2);
  let text =
    block.text.slice(0, m.index) +
    "```json\n" +
    json +
    "\n```" +
    block.text.slice(m.index + m[0].length);
  const i = text.indexOf("- Next:");
  text =
    i === -1
      ? `${line}\n${text}`
      : text.slice(0, i) + line + "\n" + text.slice(i);
  return { ...res, content: [{ ...block, text }, ...res.content.slice(1)] };
}
