/**
 * `orca_wait` (registered by `registerOrcaSettleTools`; direct-only like the
 * rest): one bounded `check --wait`, worker_done payloads, other messages,
 * stall verdicts with evidence ids, reclaimable terminals, and ATTENTION
 * entries (docs/plans/2026-09-30-orca-unverifiable-never-started.md).
 *
 * ⛔ Attention entries carry no evidence_id and are never stored in
 * `state.verdicts`, so `orca_stop` refuses them. A `never-started-unverifiable`
 * entry is a dropped brief while Orca cannot verify the agent — Orca's guide
 * forbids stop/abandon/retry/release there; the coordinator tells the user.
 * Never acks.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
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
import type { AttentionEntry } from "./stall.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";

function messageRow(m: SettledMessage) {
  return {
    message_id: m.id,
    type: m.type,
    subject: m.subject,
    body: clip(m.body ?? ""),
    payload: m.payload,
  };
}

export function registerOrcaWaitTool(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  server.tool(
    "orca_wait",
    `Wait (bounded, default 35 s, max 40 s; plus ≤10 s of stall checks) for a Run's workers: returns worker_done payloads, escalations/questions, stall verdicts (exited, auth error, idle, or a brief that never reached the agent — each with an evidence_id for orca_stop), attention entries (no evidence_id: report them to the user; never a stop), and reclaimable terminals still to release. Does NOT acknowledge — process everything, then orca_ack(delivery_id). A timeout is a checkpoint: call again. ${DIRECT}`,
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
          task_id: v.taskId ?? null,
          reason: v.reason,
          evidence: v.evidence,
          evidence_id: evidenceId,
        };
      });
      // Terminals owing a release decision; any release answer (retained
      // included) settles one for this session, so the list cannot loop.
      const reclaimable = r.reclaimable
        .filter((t) => !state.released.has(t.dispatchId))
        .map((t) => ({
          dispatch_id: t.dispatchId,
          task_id: t.taskId ?? null,
          terminal: t.terminal ?? null,
        }));
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

      const attention = r.attention
        .filter(
          (a) =>
            !state.released.has(a.dispatchId) &&
            !state.attentionReported.has(`${a.dispatchId}:${a.kind}`),
        )
        .map(attentionRow);
      for (const a of attention) {
        state.attentionReported.add(`${a.dispatch_id}:${a.kind}`);
      }

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
        ...attention.map(attentionLine),
        ...reclaimable.map(
          (t) =>
            `- **reclaimable** ${t.dispatch_id}${t.task_id ? ` (${t.task_id})` : ""}: settled, its terminal awaits orca_release`,
        ),
      ];
      if (r.stallError) {
        lines.push(
          `- Stall check failed: ${r.stallError.message} — reclaimable terminals unknown this round`,
        );
      }
      const next: string[] = [];
      if (r.messages.length) {
        next.push(
          `process every message (verify completion yourself), then orca_ack(delivery_id=${r.deliveryId})`,
        );
      }
      if (stalls.some((s) => s.reason === "never-started")) {
        next.push(
          "for a never-started stall (the brief never reached the agent): orca_stop(dispatch_id, evidence_id), then orca_start({task_id, worktree, agent, retry_of: dispatch_id}) for a fresh capability; never resend the brief by hand (dispatch-show --preamble omits the capability)",
        );
      }
      if (stalls.some((s) => s.reason !== "never-started")) {
        next.push(
          "for each other stall: orca_stop(dispatch_id, evidence_id), then ask the user Retry / Skip / Stop",
        );
      }
      if (attention.length) {
        next.push(
          "tell the user about each attention entry; attention never authorizes orca_stop, orca_abandon or a retry",
        );
      }
      if (reclaimable.length) {
        next.push(
          "orca_release each reclaimable dispatch once its worker_done is processed; do not end the coordinator turn while any remain",
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
        reclaimable,
        attention,
        active_dispatches: r.verdicts.length,
        ...(r.stallError
          ? { stall_error: r.stallError, reclaimable_unknown: true }
          : {}),
      });
    },
  );
}

/** Structured attention row — deliberately no `evidence_id`. */
function attentionRow(a: AttentionEntry) {
  return {
    kind: a.kind,
    dispatch_id: a.dispatchId,
    task_id: a.taskId ?? null,
    ...(a.evidence ? { evidence: a.evidence } : {}),
    ...(a.kind === "orca-attention"
      ? { categories: a.categories ?? [], next_action: a.nextAction ?? null }
      : {}),
  };
}

function attentionLine(a: ReturnType<typeof attentionRow>): string {
  if (a.kind === "never-started-unverifiable") {
    return `- **attention** ${a.dispatch_id} (never-started-unverifiable): ${a.evidence ?? ""} — the brief was probably dropped; Orca's agent liveness is unverifiable, so Orca forbids stop/retry: tell the user`;
  }
  const cats = "categories" in a ? (a.categories ?? []).join(", ") : "";
  const next =
    "next_action" in a && a.next_action
      ? a.next_action.join(" ")
      : "none — inspect";
  return `- **attention** ${a.dispatch_id} (orca-attention: ${cats}): Orca's next action: ${next} — tell the user; never a stop`;
}
