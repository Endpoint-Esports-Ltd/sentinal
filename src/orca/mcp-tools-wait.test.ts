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

// ------------------------------------------------- heartbeats (Task 3 of
// docs/plans/2026-09-30-orca-prewarmed-start.md)

const TIMEOUT = ok({
  runId: "run_hb",
  deliveryId: null,
  messages: [],
  timedOut: true,
});
const fenced = out(
  JSON.stringify({
    id: "x",
    ok: false,
    error: { code: "consumer_fenced", message: "consumer fenced" },
  }),
  1,
);

/** Replays `checks` in order for each `check --wait`; acks and stall reads are canned. */
function checkSeq(checks: OrcaRunOutput[]) {
  const calls: string[][] = [];
  let i = 0;
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.startsWith("orchestration check") && args.includes("--ack")) {
      return ok({ runId: "run_hb", deliveryId: null, messages: [] });
    }
    if (line.startsWith("orchestration check")) {
      return checks[Math.min(i++, checks.length - 1)]!;
    }
    if (line.startsWith("orchestration worker-list"))
      return ok({ workers: [] });
    throw new Error(`unexpected orca call: ${line}`);
  };
  const waits = () =>
    calls.filter((c) => c[1] === "check" && c.includes("--wait")).length;
  return { runner, calls, waits };
}

function withMessages(base: string, extra: Record<string, unknown>[]) {
  const doc = JSON.parse(base) as {
    result: { messages: Record<string, unknown>[] };
  };
  doc.result.messages.push(...extra);
  return out(JSON.stringify(doc));
}

const HEARTBEAT = {
  id: "msg_hbx",
  run_id: "run_93672f816e9f",
  subject: "alive",
  body: "",
  type: "heartbeat",
  payload: '{"taskId":"task_hb","dispatchId":"ctx_hb","phase":"implementing"}',
  created_at: "2026-09-30 22:00:01",
};

describe("orca_wait — heartbeats", () => {
  it("acks a heartbeat-only delivery and renders a timed-out checkpoint", async () => {
    const s = checkSeq([out(fixture("check-heartbeat-only.json")), TIMEOUT]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb", timeout_ms: 5_000 });
    const ack = s.calls.find((c) => c.includes("--ack"));
    expect(ack?.slice(0, 6)).toEqual([
      "orchestration",
      "check",
      "--run",
      "run_hb",
      "--ack",
      "delivery_hb0001",
    ]);
    expect(r.data).toMatchObject({
      ok: true,
      timed_out: true,
      messages: [],
      worker_done: [],
      heartbeats_acked: 2,
      delivery_id: null,
    });
    expect(r.text).toContain("timed out (checkpoint)");
    expect(r.text).toContain("call orca_wait again");
  });

  it("keeps waiting after a heartbeat-only delivery and returns a later worker_done", async () => {
    const s = checkSeq([
      out(fixture("check-heartbeat-only.json")),
      out(fixture("check-worker-done.json")),
    ]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb", timeout_ms: 5_000 });
    expect(s.waits()).toBe(2);
    expect(r.data.timed_out).toBe(false);
    expect(r.data.heartbeats_acked).toBe(2);
    expect(r.data.delivery_id).toBe("delivery_aa54dfdecfad");
    expect(r.data.worker_done).toEqual([
      expect.objectContaining({ dispatch_id: "ctx_4c968df3149b" }),
    ]);
  });

  it("never loops more than 3 times on repeated heartbeat-only deliveries", async () => {
    const s = checkSeq([out(fixture("check-heartbeat-only.json"))]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb", timeout_ms: 5_000 });
    expect(s.waits()).toBe(3);
    expect(r.data.timed_out).toBe(true);
    expect(r.data.heartbeats_acked).toBe(6);
  });

  it("does not auto-ack a mixed delivery and counts its heartbeats", async () => {
    const s = checkSeq([
      withMessages(fixture("check-worker-done.json"), [HEARTBEAT]),
    ]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb" });
    expect(s.calls.some((c) => c.includes("--ack"))).toBe(false);
    expect(r.data.heartbeats).toBe(1);
    expect(r.data.messages).toEqual([]);
    expect(r.data.worker_done.length).toBe(1);
    expect(r.data.delivery_id).toBe("delivery_aa54dfdecfad");
    expect(r.text).toContain("orca_ack(delivery_id=delivery_aa54dfdecfad)");
    expect(r.text).not.toContain("**heartbeat**");
  });

  it("names orca_reply for a question", async () => {
    const q = JSON.parse(fixture("check-worker-done.json")) as {
      result: { messages: Record<string, unknown>[] };
    };
    q.result.messages = [
      {
        ...HEARTBEAT,
        id: "msg_q1",
        type: "question",
        subject: "Which base branch?",
        payload: null,
      },
    ];
    const s = checkSeq([out(JSON.stringify(q))]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb" });
    expect(r.text).toMatch(
      /Next:.*orca_reply\(\{ ?run_id, message_id, body ?\}\)/,
    );
  });

  it("hints orca_rebind on consumer_fenced", async () => {
    const s = checkSeq([fenced]);
    const { call } = capture({ runner: s.runner, env: {} });
    const r = await call("orca_wait", { run_id: "run_hb" });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("consumer_fenced");
    expect(r.text).toContain(
      "This Run is bound to another coordinator terminal (e.g. after an Orca restart). If that terminal is gone, call orca_rebind({ run_id }) to bind it here.",
    );
  });
});
