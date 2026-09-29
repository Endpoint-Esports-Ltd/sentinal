/**
 * `orca_abandon` — the recovery for a stop Orca cannot prove (Task 9 of
 * docs/plans/2026-09-29-orca-dropped-prompt.md; registered by
 * `registerOrcaTools`, direct-only like the rest).
 *
 * Verified live (Orca 1.4.216): `worker-stop` can answer `stop_unknown` —
 * e.g. when Orca has marked the worker's terminal `user_owned` /
 * `user_takeover` — and the dispatch then stays `dispatched`, so
 * `worker-start --retry-of` is refused. Orca's guide
 * (`--reference recovery-and-cleanup`): for an unknown outcome, inspect, then
 * make an EXPLICIT `worker-stop` or `worker-abandon`. `worker-abandon` fences
 * orchestration (dispatch → failed) without touching processes or files;
 * `--retry-of` is then accepted.
 *
 * ⛔ Gated on Orca's OWN evidence, never on absence: `worker-show` must report
 * the worker in `stop_unknown` / `stop_outcome_unknown`. A healthy worker can
 * never be abandoned here, and the gate survives a new session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOrca, type OrcaRunner } from "./cli.js";
import { err, mutate, type Failure } from "./dispatch-start.js";
import {
  orcaFailure,
  orcaResponse,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";
import type { OrcaWorkerShowResult } from "./types.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";
const TITLE = "Orca abandon";

interface AbandonResult {
  dispatchId?: string;
  state?: string;
  processAction?: string;
  [key: string]: unknown;
}

/** Is this dispatch in Orca's stop-outcome-unknown state? */
function stopUnknown(show: OrcaWorkerShowResult | undefined): boolean {
  const w = show?.worker;
  return w?.state === "stop_unknown" || w?.stage === "stop_outcome_unknown";
}

/** `worker-abandon`, only after `worker-show` proves `stop_unknown`. */
export async function abandonWorker(
  dispatchId: string,
  o: { runner?: OrcaRunner } = {},
): Promise<{ ok: true; result: AbandonResult; requestId: string } | Failure> {
  const show = await runOrca<OrcaWorkerShowResult>(
    ["orchestration", "worker-show", "--dispatch", dispatchId],
    { runner: o.runner },
  );
  if (!show.ok) {
    return err(
      "abandon_refused",
      `Refusing to abandon ${dispatchId}: worker-show failed (${show.error.message}); absence never authorizes an abandon`,
    );
  }
  if (!stopUnknown(show.result)) {
    const s = show.result?.worker;
    return err(
      "abandon_refused",
      `Refusing to abandon ${dispatchId}: Orca reports worker ${s?.state ?? "?"} / ${s?.stage ?? "?"}, not stop_unknown. Only a stop Orca could not prove is abandoned here.`,
    );
  }
  return mutate<AbandonResult>(["worker-abandon", "--dispatch", dispatchId], {
    runner: o.runner,
  });
}

export function registerOrcaAbandonTool(
  server: McpServer,
  deps: OrcaToolsDeps,
): void {
  server.tool(
    "orca_abandon",
    `DESTRUCTIVE: abandon a supervised Orca worker (worker-abandon) whose orca_stop ended stop_unknown — Orca could not prove the stop (e.g. the terminal was taken over). Refused unless worker-show reports stop_unknown. Fences the dispatch as failed without touching processes or files, so orca_start({ …, retry_of }) can start a replacement. Ask the user first. ${DIRECT}`,
    { dispatch_id: z.string().min(1) },
    async (args) => {
      const r = await abandonWorker(args.dispatch_id, { runner: deps.runner });
      if (!r.ok) {
        return orcaFailure(TITLE, r.error, { dispatch_id: args.dispatch_id });
      }
      return orcaResponse(
        TITLE,
        [
          `- Abandoned ${args.dispatch_id} (${r.result?.state ?? "?"}; processes and files untouched).`,
          `- Next: orca_start({ task_id, worktree, agent, retry_of: "${args.dispatch_id}" }) starts a replacement with a fresh capability. The old terminal is retained by Orca; it is not closed.`,
        ],
        {
          ok: true,
          dispatch_id: args.dispatch_id,
          state: r.result?.state ?? null,
          request_id: r.requestId,
        },
      );
    },
  );
}
