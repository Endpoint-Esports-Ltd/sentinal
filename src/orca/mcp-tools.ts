/**
 * Orca MCP tools (Task 10 of docs/plans/2026-09-28-orca-orchestration.md).
 *
 *   - orca_status   — detection, resolved orchestration mode + reason, agent auth
 *   - orca_dispatch — ensure the Run, create Tasks (deps by key), prepare child
 *                     worktrees; starts NOTHING (fast, well under the MCP timeout)
 *   - orca_start    — `mcp-tools-start.ts`: ONE worker within a 45 s budget;
 *                     `pending` + request id when slower (call again to join/replay)
 *   - orca_wait / orca_ack / orca_stop / orca_release / orca_remove_worktree
 *                   — `mcp-tools-settle.ts`
 *   - orca_abandon  — `mcp-tools-abandon.ts`: the recovery for a stop Orca
 *                     could not prove (`stop_unknown`), gated on worker-show
 *   - orca_reply / orca_rebind — `mcp-tools-coord.ts`: answer a worker's
 *                     question; rebind a fenced Run to this terminal (refuses
 *                     a Run held by another live coordinator unless force)
 *
 * ## ⛔ Direct-only, on purpose
 *
 * Orca's state lives in Orca; the sidecar holds nothing warm for it. `client`
 * and `store` are accepted to keep `createSentinalServer` uniform and are
 * deliberately unused — do not add a sidecar route.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parsePlanFile } from "../spec/parser.js";
import { requiredEnum } from "../utils/schema.js";
import {
  resolveOrchestrationMode,
  type OrchestrationMode,
} from "../spec/orchestration-mode.js";
import { agentAuth, detectOrca } from "./detect.js";
import { createTask, ensureRun, prepareChildWorktree } from "./dispatch.js";
import { registerOrcaAbandonTool } from "./mcp-tools-abandon.js";
import { registerOrcaCoordTools } from "./mcp-tools-coord.js";
import { registerOrcaSettleTools } from "./mcp-tools-settle.js";
import { registerOrcaStartTool } from "./mcp-tools-start.js";
import {
  createOrcaToolState,
  orcaFailure,
  orcaResponse,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";

export type { OrcaToolsDeps } from "./mcp-tools-shared.js";

const DIRECT = "Direct-only: talks to the local `orca` CLI, never the sidecar.";

export function registerOrcaTools(
  server: McpServer,
  deps: OrcaToolsDeps = {},
): void {
  const state = createOrcaToolState();
  registerStatusTool(server, deps);
  registerDispatchTool(server, deps);
  registerOrcaStartTool(server, deps, state);
  registerOrcaSettleTools(server, deps, state);
  registerOrcaAbandonTool(server, deps);
  registerOrcaCoordTools(server, deps);
}

// ------------------------------------------------------------- orca_status

function registerStatusTool(server: McpServer, deps: OrcaToolsDeps): void {
  server.tool(
    "orca_status",
    `Should this spec run use Orca workers or sub-agents? Detects Orca (ORCA_TERMINAL_HANDLE, runtime ready, orchestration.contract.v1), resolves the mode from the plan header / SENTINAL_ORCHESTRATION, and preflights the worker agent's login. Read-only. ${DIRECT}`,
    {
      scope: requiredEnum(
        ["master", "plan"],
        "master = spec-master-execute; plan = one plan's waves (opt-in)",
      ),
      agent: z
        .string()
        .min(1)
        .describe(
          "Worker agent id — the coordinator's own agent (claude | opencode)",
        ),
      plan_path: z
        .string()
        .optional()
        .describe("Plan whose `Orchestration:` header should be honoured"),
    },
    async (args) => {
      const env = deps.env ?? process.env;
      let planHeader: OrchestrationMode | undefined;
      let planError: string | undefined;
      if (args.plan_path) {
        try {
          planHeader = parsePlanFile(args.plan_path).metadata?.orchestration;
        } catch (e) {
          planError = e instanceof Error ? e.message : String(e);
        }
      }
      const detection = await detectOrca({ env, runner: deps.runner });
      const decision = await resolveOrchestrationMode({
        env,
        planHeader,
        scope: args.scope,
        detect: () => ({
          available: detection.available,
          reason: detection.detail,
        }),
      });
      const auth = await agentAuth(args.agent, { runner: deps.runner });
      const data = {
        mode: decision.mode,
        reason: decision.reason,
        scope: args.scope,
        plan_header: planHeader ?? null,
        ...(planError ? { plan_error: planError } : {}),
        // Only the orchestration capabilities: the full list (~100 entries)
        // costs the calling agent context and decides nothing here.
        detection: {
          ...detection,
          capabilities: detection.capabilities.filter((c) =>
            c.startsWith("orchestration."),
          ),
        },
        auth,
      };
      const lines = [
        `- **Mode:** ${decision.mode} — ${decision.reason}`,
        `- **Orca:** ${detection.detail}`,
        `- **Terminal handle:** ${detection.terminalHandle ?? "(none)"}`,
        `- **App version:** ${detection.appVersion ?? "(unknown)"}`,
        `- **Agent ${auth.agent}:** ${auth.ok ? `ok (${auth.reason})` : `NOT usable — ${auth.reason}: ${auth.detail}`}`,
      ];
      if (planError) lines.push(`- **Plan not read:** ${planError}`);
      return orcaResponse("Orca status", lines, data);
    },
  );
}

// ----------------------------------------------------------- orca_dispatch

const placementSchema = z.union([
  z.literal("current"),
  z.literal("prepare-child"),
  z.object({ path: z.string().min(1) }),
]);

const dispatchTaskSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("Caller's key; other tasks' deps may name it"),
  title: z.string().min(1),
  spec: z
    .string()
    .min(1)
    .describe("Full brief: plan path, task, and how to report worker_done"),
  deps: z
    .array(z.string().min(1))
    .optional()
    .describe("Keys within this call, or existing Orca task ids"),
  worktree: placementSchema,
  name: z.string().optional().describe("prepare-child: worktree name"),
  base_branch: z.string().optional().describe("prepare-child: base branch"),
});

type DispatchTask = z.infer<typeof dispatchTaskSchema>;

/** Validate and order tasks so every in-call dependency is created first. */
export function orderDispatchTasks(
  tasks: DispatchTask[],
): { ok: true; order: DispatchTask[] } | { ok: false; message: string } {
  if (tasks.length === 0) return { ok: false, message: "no tasks given" };
  const byKey = new Map<string, DispatchTask>();
  for (const t of tasks) {
    if (byKey.has(t.key))
      return { ok: false, message: `duplicate key ${t.key}` };
    byKey.set(t.key, t);
    if (t.worktree === "prepare-child" && (!t.name || !t.base_branch)) {
      return {
        ok: false,
        message: `task ${t.key}: prepare-child needs name and base_branch`,
      };
    }
  }
  const order: DispatchTask[] = [];
  const placed = new Set<string>();
  while (order.length < tasks.length) {
    const next = tasks.find(
      (t) =>
        !placed.has(t.key) &&
        (t.deps ?? []).every((d) => !byKey.has(d) || placed.has(d)),
    );
    if (!next) {
      const stuck = tasks.filter((t) => !placed.has(t.key)).map((t) => t.key);
      return {
        ok: false,
        message: `dependency cycle among ${stuck.join(", ")}`,
      };
    }
    order.push(next);
    placed.add(next.key);
  }
  return { ok: true, order };
}

interface DispatchedTask {
  key: string;
  task_id: string;
  title: string;
  deps: string[];
  placement: "current" | { path: string };
  status: "awaiting_start";
  worktree?: { path: string; branch?: string; worktree_id: string | null };
  next: string;
}

function nextStep(t: DispatchTask, d: DispatchedTask): string {
  const start = `orca_start(task_id=${d.task_id}, worktree=${typeof d.placement === "string" ? d.placement : `{path: ${d.placement.path}}`})`;
  const after = d.deps.length
    ? " once its dependencies reported worker_done"
    : "";
  if (d.worktree) {
    return `worktree_ensure(path=${d.worktree.path}, owner=external, base=${t.base_branch}) then ${start}${after}`;
  }
  return `${start}${after}`;
}

function registerDispatchTool(server: McpServer, deps: OrcaToolsDeps): void {
  server.tool(
    "orca_dispatch",
    `Create Orca Tasks for a wave/phase set: binds (or reuses) this coordinator's Run — refusing a Run bound to another terminal — creates every task with its dependencies (keys resolved to task ids), and for worktree "prepare-child" creates the child worktree WITHOUT an agent. Starts no worker: call worktree_ensure for prepared worktrees, then orca_start per task. ${DIRECT}`,
    {
      objective: z.string().min(1),
      tasks: z.array(dispatchTaskSchema).min(1),
      agent: z
        .string()
        .min(1)
        .describe(
          "Worker agent id; its login is preflighted before anything is created",
        ),
      coordinator_handle: z
        .string()
        .optional()
        .describe("Override for ORCA_TERMINAL_HANDLE"),
      run_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Resume this existing Run (e.g. in a new session): binds it to this terminal with run-use",
        ),
    },
    async (args) => {
      const title = "Orca dispatch";
      const ordered = orderDispatchTasks(args.tasks);
      if (!ordered.ok) {
        return orcaFailure(title, {
          code: "invalid_tasks",
          message: ordered.message,
        });
      }
      const auth = await agentAuth(args.agent, { runner: deps.runner });
      if (!auth.ok) {
        return orcaFailure(
          title,
          {
            code: "agent_auth",
            message: `${auth.agent} cannot run workers: ${auth.detail} (${auth.reason}). Use opencode, or /login and retry.`,
          },
          { auth },
        );
      }
      const run = await ensureRun({
        objective: args.objective,
        coordinatorHandle: args.coordinator_handle,
        runId: args.run_id,
        env: deps.env,
        runner: deps.runner,
      });
      if (!run.ok) return orcaFailure(title, run.error);

      const out: DispatchedTask[] = [];
      const ids = new Map<string, string>();
      const base = { run_id: run.run.id, run_reused: run.reused };
      const partial = (error: { code: string; message: string }) =>
        orcaFailure(title, error, { ...base, tasks: out }, [
          `${out.length} task(s) were created before the failure; none started.`,
        ]);

      for (const t of ordered.order) {
        const depIds = (t.deps ?? []).map((d) => ids.get(d) ?? d);
        const made = await createTask({
          runId: run.run.id,
          title: t.title,
          spec: t.spec,
          deps: depIds,
          runner: deps.runner,
        });
        if (!made.ok) return partial(made.error);
        ids.set(t.key, made.task.id);
        const entry: DispatchedTask = {
          key: t.key,
          task_id: made.task.id,
          title: t.title,
          deps: depIds,
          placement: t.worktree === "prepare-child" ? "current" : t.worktree,
          status: "awaiting_start",
          next: "",
        };
        out.push(entry);
        if (t.worktree === "prepare-child") {
          const wt = await prepareChildWorktree({
            name: t.name!,
            baseBranch: t.base_branch!,
            runner: deps.runner,
          });
          if (!wt.ok) return partial(wt.error);
          entry.placement = { path: wt.path };
          entry.worktree = {
            path: wt.path,
            ...(wt.branch ? { branch: wt.branch } : {}),
            worktree_id: wt.worktreeId,
          };
        }
        entry.next = nextStep(t, entry);
      }

      const lines = [
        `- **Run:** ${run.run.id} (${run.reused ? "reused" : "created"})`,
        ...out.map((d) => `- **${d.key}** → ${d.task_id}: next ${d.next}`),
        "",
        "No worker was started. Prepared worktrees must be adopted (worktree_ensure) BEFORE orca_start.",
      ];
      return orcaResponse(title, lines, { ok: true, ...base, tasks: out });
    },
  );
}
