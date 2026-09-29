/**
 * `orca_abandon` (Task 9 of docs/plans/2026-09-29-orca-dropped-prompt.md) and
 * `orca_stop`'s `stop_unknown` hint. Fake runner only — never the real `orca`.
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
const fail = (code: string, message: string): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: false, error: { code, message } }), 1);

function fakeOrca(routes: Array<[string, OrcaRunOutput]>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    const hit = routes.find(([p]) => line.startsWith(p));
    if (!hit) throw new Error(`unexpected orca call: ${line}`);
    return hit[1];
  };
  const called = (p: string) => calls.filter((c) => c.join(" ").startsWith(p));
  return { runner, called };
}

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

const D = "ctx_c8a313c725e8";
const showStopUnknown = out(fixture("worker-show-stop-unknown.json"));
const showDispatched = out(fixture("worker-show-dispatched.json"));
const abandoned = ok({
  dispatchId: D,
  state: "abandoned",
  processAction: "none",
});

describe("orca_abandon", () => {
  it("is registered, DESTRUCTIVE, and names its evidence gate", () => {
    const { tools } = capture({ env: {} });
    const t = tools.get("orca_abandon");
    expect(t).toBeDefined();
    expect(t!.desc).toMatch(/^DESTRUCTIVE/);
    expect(t!.desc).toContain("stop_unknown");
  });

  it("abandons a dispatch Orca reports as stop_unknown", async () => {
    const f = fakeOrca([
      ["orchestration worker-show", showStopUnknown],
      ["orchestration worker-abandon", abandoned],
    ]);
    const { call } = capture({ runner: f.runner, env: {} });
    const r = await call("orca_abandon", { dispatch_id: D });
    expect(r.data).toMatchObject({
      ok: true,
      dispatch_id: D,
      state: "abandoned",
    });
    const ab = f.called("orchestration worker-abandon")[0]!;
    expect(ab).toContain(D);
    expect(ab).toContain("--retry-request");
    expect(r.text).toContain("retry_of");
  });

  it("refuses a worker that is not stop_unknown (a healthy dispatch)", async () => {
    const f = fakeOrca([
      ["orchestration worker-show", showDispatched],
      ["orchestration worker-abandon", abandoned],
    ]);
    const { call } = capture({ runner: f.runner, env: {} });
    const r = await call("orca_abandon", { dispatch_id: D });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("abandon_refused");
    expect(f.called("orchestration worker-abandon")).toHaveLength(0);
  });

  it("refuses when worker-show fails (absence authorizes nothing)", async () => {
    const f = fakeOrca([
      ["orchestration worker-show", fail("runtime_error", "boom")],
      ["orchestration worker-abandon", abandoned],
    ]);
    const { call } = capture({ runner: f.runner, env: {} });
    const r = await call("orca_abandon", { dispatch_id: D });
    expect(r.data.ok).toBe(false);
    expect(f.called("orchestration worker-abandon")).toHaveLength(0);
  });
});

describe("orca_stop — stop_unknown", () => {
  it("names orca_abandon and retry_of when Orca cannot prove the stop", async () => {
    const f = fakeOrca([
      [
        "orchestration check",
        ok({ runId: "run_x", deliveryId: null, messages: [], timedOut: true }),
      ],
      [
        "orchestration worker-list",
        ok({
          workers: [
            {
              dispatchId: D,
              taskId: "task_home",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "live" },
              },
            },
          ],
        }),
      ],
      [
        "orchestration worker-read",
        out(fixture("worker-read-terminal-home.json")),
      ],
      ["orchestration worker-show", showDispatched],
      [
        "orchestration worker-stop",
        ok({
          dispatchId: D,
          state: "stop_unknown",
          lastError:
            "The worker terminal is user_owned; no terminal was closed.",
        }),
      ],
    ]);
    const { call } = capture({
      runner: f.runner,
      env: {},
      now: () => Date.parse("2026-09-29T21:46:28Z") + 4 * 60_000,
    });
    const w = await call("orca_wait", { run_id: "run_x" });
    const s = await call("orca_stop", {
      dispatch_id: D,
      evidence_id: w.data.stalls[0].evidence_id,
    });
    expect(s.data.ok).toBe(false);
    expect(s.data.error.code).toBe("stop_unknown");
    expect(s.text).toContain("orca_abandon");
    expect(s.text).toContain("retry_of");
    expect(s.text).toContain("ask the user");
  });
});
