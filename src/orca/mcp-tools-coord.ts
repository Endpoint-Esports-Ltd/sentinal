/**
 * Coordinator tools (Task 4 of docs/plans/2026-09-30-orca-prewarmed-start.md):
 *
 *   - orca_reply  — answer a worker's question (`orchestration reply`)
 *   - orca_rebind — re-bind a Run to this coordinator terminal
 *                   (`orchestration run-use`) after an Orca restart fenced
 *                   the old consumer. Explicit, never automatic.
 *
 * ⛔ The rebind refusal is enforced in code: when `run-show` names another
 * coordinator terminal and `terminal show` reports it `connected: true`, a
 * live coordinator still holds the Run — refuse unless `force`. A stale or
 * disconnected terminal (or none) is safe to take over; anything unverifiable
 * is refused unless `force`.
 *
 * Direct-only, like every orca_* tool (see mcp-tools.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOrca } from "./cli.js";
import { mutate } from "./dispatch-start.js";
import {
  orcaFailure,
  orcaResponse,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";
import type { OrcaRunShowResult, OrcaTerminalShowResult } from "./types.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";

export function registerOrcaCoordTools(
  server: McpServer,
  deps: OrcaToolsDeps = {},
): void {
  registerReplyTool(server, deps);
  registerRebindTool(server, deps);
}

// --------------------------------------------------------------- orca_reply

/** Orca's reply receipt shape is not pinned down; accept the likely spellings. */
function replyMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const msg = r.message as Record<string, unknown> | undefined;
  const id = msg?.id ?? r.messageId ?? r.message_id ?? r.id;
  return typeof id === "string" && id ? id : undefined;
}

function registerReplyTool(server: McpServer, deps: OrcaToolsDeps): void {
  server.tool(
    "orca_reply",
    `Answer a worker's question (from orca_wait) before its ask times out. ${DIRECT}`,
    {
      run_id: z.string().min(1),
      message_id: z
        .string()
        .min(1)
        .describe("Id of the worker's question message, from orca_wait"),
      body: z.string().min(1),
    },
    async (args) => {
      const title = "Orca reply";
      const r = await mutate<unknown>(
        [
          "reply",
          "--run",
          args.run_id,
          "--id",
          args.message_id,
          "--body",
          args.body,
        ],
        { runner: deps.runner },
      );
      if (!r.ok) return orcaFailure(title, r.error, { run_id: args.run_id });
      const replyId = replyMessageId(r.result);
      return orcaResponse(
        title,
        [
          `- **Replied to:** ${args.message_id} (run ${args.run_id})`,
          ...(replyId ? [`- **Reply message:** ${replyId}`] : []),
        ],
        {
          ok: true,
          run_id: args.run_id,
          message_id: args.message_id,
          ...(replyId ? { reply_message_id: replyId } : {}),
        },
      );
    },
  );
}

// -------------------------------------------------------------- orca_rebind

function registerRebindTool(server: McpServer, deps: OrcaToolsDeps): void {
  server.tool(
    "orca_rebind",
    `Rebind a Run to this coordinator terminal after an Orca restart (orca_wait reports consumer_fenced). Refuses when another live coordinator terminal holds the Run unless force. Never automatic. ${DIRECT}`,
    {
      run_id: z.string().min(1),
      force: z
        .boolean()
        .optional()
        .describe(
          "Take the Run even though its coordinator terminal is still live",
        ),
    },
    async (args) => {
      const title = "Orca rebind";
      const base = { run_id: args.run_id };
      // Same source as orca_status / detectOrca.
      const env = deps.env ?? process.env;
      const mine = env.ORCA_TERMINAL_HANDLE?.trim() || null;
      if (!mine) {
        return orcaFailure(
          title,
          {
            code: "not_in_orca_terminal",
            message:
              "ORCA_TERMINAL_HANDLE is not set: not running inside an Orca terminal",
          },
          base,
        );
      }

      const shown = await runOrca<OrcaRunShowResult>(
        ["orchestration", "run-show", "--id", args.run_id],
        { runner: deps.runner },
      );
      if (!shown.ok) return orcaFailure(title, shown.error, base);
      const previous = shown.result.run?.coordinator_handle?.trim() || null;

      if (previous === mine) {
        return orcaResponse(
          title,
          [`- **Run:** ${args.run_id} is already bound to this terminal`],
          { ok: true, ...base, already_bound: true, coordinator: mine },
        );
      }

      if (previous) {
        const term = await runOrca<OrcaTerminalShowResult>(
          ["terminal", "show", "--terminal", previous],
          { runner: deps.runner },
        );
        // Only positive evidence that the holder is gone allows a takeover:
        // a stale handle or connected:false. Any other error is unverified.
        const gone = term.ok
          ? term.result.terminal?.connected === false
          : term.error.code === "terminal_handle_stale";
        const live = term.ok && term.result.terminal?.connected === true;
        if (!live && !gone && args.force !== true) {
          return orcaFailure(
            title,
            {
              code: "rebind_unverified",
              message: `Could not verify whether coordinator terminal ${previous} still holds Run ${args.run_id} (${term.ok ? "no connected field" : term.error.message}); pass force: true only if that coordinator is abandoned`,
            },
            { ...base, previous_coordinator: previous },
          );
        }
        if (live && args.force !== true) {
          return orcaFailure(
            title,
            {
              code: "rebind_refused",
              message: `Run ${args.run_id} is held by live coordinator terminal ${previous}; pass force: true only if that coordinator is abandoned`,
            },
            { ...base, previous_coordinator: previous },
          );
        }
      }

      const used = await mutate<unknown>(["run-use", "--id", args.run_id], {
        runner: deps.runner,
      });
      if (!used.ok) {
        return orcaFailure(title, used.error, {
          ...base,
          previous_coordinator: previous,
        });
      }
      return orcaResponse(
        title,
        [
          `- **Run:** ${args.run_id} bound to ${mine}`,
          `- **Previous coordinator:** ${previous ?? "(none)"}`,
        ],
        {
          ok: true,
          ...base,
          bound: true,
          coordinator: mine,
          previous_coordinator: previous,
          ...(args.force ? { forced: true } : {}),
        },
      );
    },
  );
}
