/**
 * `orca_wait` attention entries (Task 3 of
 * docs/plans/2026-09-30-orca-unverifiable-never-started.md). Fake runner
 * only — never the real `orca`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { registerOrcaTools, type OrcaToolsDeps } from "./mcp-tools.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");
const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>;

function capture(deps: OrcaToolsDeps) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, { desc: string; h: Handler }>();
  server.tool = ((...a: unknown[]) => {
    tools.set(a[0] as string, { desc: a[1] as string, h: a[3] as Handler });
  }) as typeof server.tool;
  registerOrcaTools(server, deps);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools.get(name)!.h(args);
    const text = r.content[0]!.text;
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    return { text, data: m ? JSON.parse(m[1]!) : undefined };
  };
  return { call, tools };
}

const RUN = "run_d209";
const D = "ctx_d209000000a1";
const OTHER = "ctx_failure01";
const AT = Date.parse("2026-09-29T23:11:43Z");

function routes() {
  const calls: string[][] = [];
  const table: Array<[string, OrcaRunOutput]> = [
    [
      "orchestration check",
      ok({ runId: RUN, deliveryId: null, messages: [], timedOut: true }),
    ],
    [
      "orchestration worker-list",
      ok({
        workers: [
          {
            dispatchId: D,
            taskId: "task_d209000000a1",
            projection: {
              outcome: "in_progress",
              liveness: { verdict: "unverifiable", reason: "missing_status" },
              attention: { categories: ["unverifiable"], requiresAction: true },
            },
          },
          {
            dispatchId: OTHER,
            taskId: "task_failure",
            projection: {
              outcome: "in_progress",
              liveness: { verdict: "unverifiable", reason: "host_unavailable" },
              nextAction: { kind: "none", argv: [] },
              attention: { categories: ["failure"], requiresAction: true },
            },
          },
        ],
      }),
    ],
    [
      `orchestration worker-read --dispatch ${D}`,
      out(fixture("worker-read-terminal-home-unverifiable.json")),
    ],
    [
      `orchestration worker-read --dispatch ${OTHER}`,
      out(fixture("worker-read-terminal-started.json")),
    ],
    [
      "orchestration worker-show",
      out(fixture("worker-show-unverifiable-209.json")),
    ],
    [
      "orchestration worker-release",
      ok({ dispatchId: OTHER, state: "released" }),
    ],
  ];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    const hit = table.find(([p]) => line.startsWith(p));
    if (!hit) throw new Error(`unexpected orca call: ${line}`);
    return hit[1];
  };
  return { runner, calls };
}

describe("orca_wait — attention entries", () => {
  const deps = (runner: OrcaRunner): OrcaToolsDeps => ({
    runner,
    env: {},
    now: () => AT + 4 * 60_000,
  });

  it("reports never-started-unverifiable with no evidence_id, and no stall", async () => {
    const { call } = capture(deps(routes().runner));
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.stalls).toEqual([]);
    const a = r.data.attention.find(
      (x: { dispatch_id: string }) => x.dispatch_id === D,
    );
    expect(a).toMatchObject({
      kind: "never-started-unverifiable",
      task_id: "task_d209000000a1",
    });
    expect(a).not.toHaveProperty("evidence_id");
    expect(r.text).toContain("probably dropped");
    expect(r.text).toContain("tell the user");
    expect(r.text).toContain(
      "attention never authorizes orca_stop, orca_abandon or a retry",
    );
  });

  it("renders an orca-attention row with Orca's next action (none → inspect)", async () => {
    const { call } = capture(deps(routes().runner));
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.attention).toContainEqual(
      expect.objectContaining({
        dispatch_id: OTHER,
        kind: "orca-attention",
        categories: ["failure"],
        next_action: null,
      }),
    );
    expect(r.text).toContain("none — inspect");
    expect(r.text).toMatch(/orca-attention[^\n]*tell the user/);
  });

  it("orca_stop refuses an attention dispatch, whatever evidence id is passed", async () => {
    const { call } = capture(deps(routes().runner));
    await call("orca_wait", { run_id: RUN });
    const s = await call("orca_stop", { dispatch_id: D, evidence_id: "ev_x" });
    expect(s.data.ok).toBe(false);
    expect(s.data.error.code).toBe("stop_refused");
  });

  it("reports each dispatch once per session, and never after release", async () => {
    const { call } = capture(deps(routes().runner));
    const first = await call("orca_wait", { run_id: RUN });
    expect(first.data.attention.length).toBe(2);
    const second = await call("orca_wait", { run_id: RUN });
    expect(second.data.attention).toEqual([]);

    const fresh = capture(deps(routes().runner));
    await fresh.call("orca_release", { dispatch_id: OTHER });
    const after = await fresh.call("orca_wait", { run_id: RUN });
    expect(
      after.data.attention.map((x: { dispatch_id: string }) => x.dispatch_id),
    ).toEqual([D]);
  });

  it("de-duplicates per dispatch AND kind, so a later never-started entry is not hidden", async () => {
    let phase = 0;
    let clock = AT + 60_000;
    const base = routes();
    const runner: OrcaRunner = async (args) => {
      if (args.join(" ").startsWith("orchestration worker-list")) {
        const cats = phase === 0 ? ["failure"] : ["unverifiable"];
        return ok({
          workers: [
            {
              dispatchId: D,
              taskId: "task_d209000000a1",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "unverifiable", reason: "missing_status" },
                attention: { categories: cats, requiresAction: true },
              },
            },
          ],
        });
      }
      return base.runner(args);
    };
    const { call } = capture({ runner, env: {}, now: () => clock });
    const first = await call("orca_wait", { run_id: RUN });
    expect(first.data.attention.map((a: { kind: string }) => a.kind)).toEqual([
      "orca-attention",
    ]);
    phase = 1;
    clock = AT + 4 * 60_000;
    const second = await call("orca_wait", { run_id: RUN });
    expect(second.data.attention.map((a: { kind: string }) => a.kind)).toEqual([
      "never-started-unverifiable",
    ]);
    const third = await call("orca_wait", { run_id: RUN });
    expect(third.data.attention).toEqual([]);
  });

  it("mentions attention in the tool description", () => {
    const { tools } = capture({ env: {} });
    expect(tools.get("orca_wait")!.desc).toContain("attention");
  });
});
