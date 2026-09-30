/**
 * Settlement half of the `orca_*` MCP tools (registered by
 * `registerOrcaTools` in `mcp-tools.ts`; direct-only like the rest):
 *
 *   - orca_wait            — `mcp-tools-wait.ts` (stalls, attention,
 *                            reclaimable; never acks)
 *   - orca_ack             — acknowledge a processed delivery
 *   - orca_stop            — DESTRUCTIVE; only with an evidence id from the
 *                            latest orca_wait of that Run (absence never
 *                            authorizes a stop)
 *   - orca_release         — DESTRUCTIVE; close a settled worker's terminal.
 *                            After a `retained` / `released` /
 *                            `already_released` answer it also closes a
 *                            terminal SENTINAL created for a pre-warmed start
 *                            (`state.createdTerminals`) and forgets it; a
 *                            close failure is reported, the release stays ok.
 *                            Orca-created terminals are never closed; a failed
 *                            release closes nothing and keeps the entry.
 *   - orca_remove_worktree — DESTRUCTIVE; `orca worktree rm` of a child
 */

import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ackDelivery,
  releaseWorker,
  removeChildWorktree,
  stopWorker,
} from "./dispatch.js";
import { closeTerminal } from "./dispatch-prewarm.js";
import {
  orcaFailure,
  orcaResponse,
  type OrcaToolState,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";
import { registerOrcaWaitTool } from "./mcp-tools-wait.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";

export function registerOrcaSettleTools(
  server: McpServer,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): void {
  registerOrcaWaitTool(server, deps, state);
  registerAck(server, deps, state);
  registerStop(server, deps, state);
  registerRelease(server, deps, state);
  registerRemoveWorktree(server, deps);
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
        const unknown = r.error.code === "stop_unknown";
        return orcaFailure(
          "Orca stop",
          r.error,
          { dispatch_id: args.dispatch_id },
          unknown
            ? [
                `- Orca could not prove the stop, so a retry is refused until the attempt is fenced. Next: ask the user, then orca_abandon({ dispatch_id: "${args.dispatch_id}" }), then orca_start({ task_id: "${entry.verdict.taskId ?? "<task_id>"}", worktree, agent, retry_of: "${args.dispatch_id}" }).`,
              ]
            : [],
        );
      }
      state.verdicts.delete(args.dispatch_id);
      return orcaResponse(
        "Orca stop",
        [
          `- Stopped ${args.dispatch_id} (${entry.verdict.reason}: ${entry.verdict.evidence}).`,
          ...(r.result?.warning ? [`- Warning: ${r.result.warning}`] : []),
          entry.verdict.reason === "never-started"
            ? `- Next: the brief never reached the agent — start a replacement with a fresh capability: orca_start({ task_id: "${entry.verdict.taskId ?? "<task_id>"}", worktree, agent, retry_of: "${args.dispatch_id}" }).`
            : "- Next: ask the user Retry / Skip / Stop.",
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
      const own = await closeOwnTerminal(args.dispatch_id, s, deps, state);
      return orcaResponse(
        "Orca release",
        [
          `- ${args.dispatch_id}: ${s}${r.result?.reason ? ` (${r.result.reason})` : ""}`,
          ...(own
            ? own.lines
            : s === "retained"
              ? [
                  "- Orca kept the terminal (not owned by this dispatch, or taken over).",
                ]
              : []),
        ],
        {
          ok: true,
          dispatch_id: args.dispatch_id,
          state: s,
          ...(own?.data ?? {}),
        },
      );
    },
  );
}

/** Release answers after which the dispatch no longer holds the terminal. */
const CLOSABLE_AFTER = new Set(["retained", "released", "already_released"]);

/**
 * Close the terminal Sentinal itself created for a pre-warmed start of this
 * dispatch, once Orca's release no longer holds it. Only handles recorded in
 * `state.createdTerminals` are ever closed — Orca's own terminals never are.
 * The entry is forgotten whether or not the close worked. Returns `null` when
 * there is nothing of Sentinal's to close.
 */
async function closeOwnTerminal(
  dispatchId: string,
  releaseState: string | null,
  deps: OrcaToolsDeps,
  state: OrcaToolState,
): Promise<{ lines: string[]; data: Record<string, string> } | null> {
  const handle = state.createdTerminals.get(dispatchId);
  if (!handle || !releaseState || !CLOSABLE_AFTER.has(releaseState)) {
    return null;
  }
  state.createdTerminals.delete(dispatchId);
  const c = await closeTerminal(handle, deps.runner);
  if (c.ok) {
    return {
      lines: [
        `- Closed Sentinal's own terminal ${handle} (it created it for the pre-warmed start).`,
      ],
      data: { closed_terminal: handle },
    };
  }
  const note =
    releaseState === "released"
      ? " Orca may already have closed it with the release, so this is informative only."
      : "";
  return {
    lines: [
      `- Could not close Sentinal's own terminal ${handle}: ${c.message}.${note}`,
    ],
    data: { close_error: c.message },
  };
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
