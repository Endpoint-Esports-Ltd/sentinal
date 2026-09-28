/**
 * Settlement half of the `orca_*` MCP tools (registered by
 * `registerOrcaTools` in `mcp-tools.ts`; direct-only like the rest):
 *
 *   - orca_wait            — one bounded `check --wait`; worker_done payloads,
 *                            other messages, stall verdicts with evidence ids.
 *                            Never acks.
 *   - orca_ack             — acknowledge a processed delivery
 *   - orca_stop            — DESTRUCTIVE; only with an evidence id from the
 *                            latest orca_wait of that Run (absence never
 *                            authorizes a stop)
 *   - orca_release         — DESTRUCTIVE; close a settled worker's terminal
 *   - orca_remove_worktree — DESTRUCTIVE; `orca worktree rm` of a child
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ackDelivery,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  releaseWorker,
  removeChildWorktree,
  stopWorker,
  waitForSettlement,
  type SettledMessage,
} from "./dispatch.js";
import {
  clip,
  orcaFailure,
  orcaResponse,
  type OrcaToolState,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";

export function registerOrcaSettleTools(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  registerWait(server, deps, state);
  registerAck(server, deps, state);
  registerStop(server, deps, state);
  registerRelease(server, deps, state);
  registerRemoveWorktree(server, deps);
}

// --------------------------------------------------------------- orca_wait

function messageRow(m: SettledMessage) {
  return {
    message_id: m.id,
    type: m.type,
    subject: m.subject,
    body: clip(m.body ?? ""),
    payload: m.payload,
  };
}

function registerWait(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_wait",
    `Wait (bounded, default 35 s, max 40 s; plus ≤10 s of stall checks) for a Run's workers: returns worker_done payloads, escalations/questions, and stall verdicts (each with an evidence_id for orca_stop). Does NOT acknowledge — process everything, then orca_ack(delivery_id). A timeout is a checkpoint: call again. ${DIRECT}`,
    {
      run_id: z.string().min(1),
      timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional(),
    },
    async (args) => {
      const r = await waitForSettlement({
        runId: args.run_id,
        timeoutMs: args.timeout_ms ?? DEFAULT_WAIT_MS,
        runner: deps.runner,
        now: deps.now?.(),
      });
      if (!r.ok) {
        return orcaFailure("Orca wait", r.error, { run_id: args.run_id });
      }

      // Only the latest wait's verdicts authorize a stop.
      for (const [id, v] of state.verdicts) {
        if (v.runId === args.run_id) state.verdicts.delete(id);
      }
      const stalls = r.stalls.map((v) => {
        const evidenceId = `ev_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        if (v.dispatchId) {
          state.verdicts.set(v.dispatchId, {
            runId: args.run_id,
            evidenceId,
            verdict: v,
          });
        }
        return {
          dispatch_id: v.dispatchId,
          reason: v.reason,
          evidence: v.evidence,
          evidence_id: evidenceId,
        };
      });
      if (r.deliveryId) state.deliveries.set(r.deliveryId, args.run_id);

      const workerDone = r.messages.flatMap((m) =>
        m.workerDone
          ? [
              {
                task_id: m.workerDone.taskId,
                dispatch_id: m.workerDone.dispatchId,
                outcome: m.workerDone.outcome,
                files_modified: m.workerDone.filesModified ?? [],
                report_path: m.workerDone.reportPath ?? null,
                subject: m.subject,
                body: clip(m.body ?? ""),
                message_id: m.id,
                replayed: state.released.has(m.workerDone.dispatchId),
              },
            ]
          : [],
      );
      const other = r.messages.filter((m) => !m.workerDone).map(messageRow);

      const lines: string[] = [
        `- **Run:** ${args.run_id} — ${r.timedOut ? "timed out (checkpoint)" : `${r.messages.length} message(s)`}`,
        ...workerDone.map(
          (d) =>
            `- **worker_done** ${d.task_id} / ${d.dispatch_id}: ${d.outcome} — ${d.subject}` +
            (d.replayed
              ? " (already settled in this session: an un-acked delivery re-sent — do not merge again; orca_ack it)"
              : ""),
        ),
        ...other.map((m) => `- **${m.type}** ${m.subject}`),
        ...stalls.map(
          (s) =>
            `- **STALL** ${s.dispatch_id} (${s.reason}): ${s.evidence} — evidence_id ${s.evidence_id}`,
        ),
      ];
      if (r.stallError) {
        lines.push(`- Stall check failed: ${r.stallError.message}`);
      }
      const next: string[] = [];
      if (r.messages.length) {
        next.push(
          `process every message (verify completion yourself), then orca_ack(delivery_id=${r.deliveryId})`,
        );
      }
      if (stalls.length) {
        next.push(
          "for each stall: orca_stop(dispatch_id, evidence_id), then ask the user Retry / Skip / Stop",
        );
      }
      if (!next.length) next.push("call orca_wait again");
      lines.push("", `Next: ${next.join("; ")}.`);

      return orcaResponse("Orca wait", lines, {
        ok: true,
        run_id: args.run_id,
        timed_out: r.timedOut,
        delivery_id: r.deliveryId,
        worker_done: workerDone,
        messages: other,
        stalls,
        active_dispatches: r.verdicts.length,
        ...(r.stallError ? { stall_error: r.stallError } : {}),
      });
    },
  );
}

// ---------------------------------------------------------------- orca_ack

function registerAck(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_ack",
    `Acknowledge a delivery from orca_wait after EVERY message in it was processed (Orca replays an unacknowledged delivery). ${DIRECT}`,
    {
      delivery_id: z.string().min(1),
      run_id: z
        .string()
        .optional()
        .describe("Needed only when this server did not see the delivery"),
    },
    async (args) => {
      const runId = args.run_id ?? state.deliveries.get(args.delivery_id);
      if (!runId) {
        return orcaFailure("Orca ack", {
          code: "unknown_delivery",
          message: `No run known for ${args.delivery_id}; pass run_id`,
        });
      }
      const r = await ackDelivery({
        runId,
        deliveryId: args.delivery_id,
        runner: deps.runner,
      });
      if (!r.ok) return orcaFailure("Orca ack", r.error, { run_id: runId });
      state.deliveries.delete(args.delivery_id);
      const waiting = Array.isArray(r.result?.messages)
        ? r.result.messages.length
        : 0;
      return orcaResponse(
        "Orca ack",
        [
          `- Acknowledged ${args.delivery_id} on ${runId}.`,
          ...(waiting
            ? [
                `- ${waiting} more message(s) are waiting: the next orca_wait returns them.`,
              ]
            : []),
        ],
        {
          ok: true,
          run_id: runId,
          delivery_id: args.delivery_id,
          pending_messages: waiting,
        },
      );
    },
  );
}

// --------------------------------------------------------------- orca_stop

function registerStop(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_stop",
    `DESTRUCTIVE: stop a stalled Orca worker (worker-stop). Refused unless evidence_id comes from the LATEST orca_wait of that Run and names this dispatch — absence of activity never authorizes a stop. Afterwards ask the user Retry / Skip / Stop. ${DIRECT}`,
    {
      dispatch_id: z.string().min(1),
      evidence_id: z.string().min(1),
    },
    async (args) => {
      const entry = state.verdicts.get(args.dispatch_id);
      if (!entry || entry.evidenceId !== args.evidence_id) {
        return orcaFailure("Orca stop", {
          code: "stop_refused",
          message: `No current stall verdict for ${args.dispatch_id} with evidence ${args.evidence_id}; run orca_wait and use the evidence_id it reports`,
        });
      }
      const r = await stopWorker(args.dispatch_id, {
        evidence: entry.verdict,
        runner: deps.runner,
      });
      if (!r.ok) {
        return orcaFailure("Orca stop", r.error, {
          dispatch_id: args.dispatch_id,
        });
      }
      state.verdicts.delete(args.dispatch_id);
      return orcaResponse(
        "Orca stop",
        [
          `- Stopped ${args.dispatch_id} (${entry.verdict.reason}: ${entry.verdict.evidence}).`,
          ...(r.result?.warning ? [`- Warning: ${r.result.warning}`] : []),
          "- Next: ask the user Retry / Skip / Stop.",
        ],
        {
          ok: true,
          dispatch_id: args.dispatch_id,
          state: r.result?.state ?? null,
          reason: entry.verdict.reason,
          request_id: r.requestId,
        },
      );
    },
  );
}

// ------------------------------------------------------------ orca_release

function registerRelease(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_release",
    `DESTRUCTIVE: release a SETTLED worker (worker-release): closes the terminal owned by that dispatch and archives its output. Only after its worker_done (or stop) was recorded. ${DIRECT}`,
    { dispatch_id: z.string().min(1) },
    async (args) => {
      const r = await releaseWorker(args.dispatch_id, { runner: deps.runner });
      if (!r.ok) {
        return orcaFailure("Orca release", r.error, {
          dispatch_id: args.dispatch_id,
        });
      }
      const s = r.result?.state ?? null;
      state.released.add(args.dispatch_id);
      return orcaResponse(
        "Orca release",
        [
          `- ${args.dispatch_id}: ${s}${r.result?.reason ? ` (${r.result.reason})` : ""}`,
          ...(s === "retained"
            ? [
                "- Orca kept the terminal (not owned by this dispatch, or taken over).",
              ]
            : []),
        ],
        { ok: true, dispatch_id: args.dispatch_id, state: s },
      );
    },
  );
}

// ---------------------------------------------------- orca_remove_worktree

function registerRemoveWorktree(server: McpServer, deps: OrcaToolsDeps): void {
  server.tool(
    "orca_remove_worktree",
    `DESTRUCTIVE: remove an Orca child worktree (orca worktree rm, no --force). Call worktree_abandon first so Sentinal releases its slot and seeded files. ${DIRECT}`,
    { path: z.string().min(1).describe("Absolute worktree path") },
    async (args) => {
      if (!isAbsolute(args.path)) {
        return orcaFailure("Orca remove worktree", {
          code: "invalid_path",
          message: `${args.path} is not an absolute path`,
        });
      }
      // Never the main checkout, this session's own checkout, or a worktree
      // Sentinal still holds live (injected by the server — see server.ts).
      const guard = await deps.guardWorktreeRemoval?.(args.path);
      if (guard && !guard.ok) {
        return orcaFailure("Orca remove worktree", {
          code: "removal_refused",
          message: `Refusing to remove ${args.path}: ${guard.reason}`,
        });
      }
      const r = await removeChildWorktree(args.path, { runner: deps.runner });
      if (!r.ok) {
        return orcaFailure("Orca remove worktree", r.error, {
          path: args.path,
        });
      }
      return orcaResponse("Orca remove worktree", [`- Removed ${args.path}.`], {
        ok: true,
        path: args.path,
        result: r.result,
      });
    },
  );
}
