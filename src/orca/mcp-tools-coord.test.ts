/**
 * `orca_reply` / `orca_rebind` (Task 4 of
 * docs/plans/2026-09-30-orca-prewarmed-start.md). Fake runner only — never
 * the real `orca`.
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

type Reply =
  OrcaRunOutput | ((args: string[]) => OrcaRunOutput | Promise<OrcaRunOutput>);

function fakeOrca(routes: Array<[string, Reply]>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    const hit = routes.find(([prefix]) => line.startsWith(prefix));
    if (!hit) throw new Error(`unexpected orca call: ${line}`);
    return typeof hit[1] === "function" ? hit[1](args) : hit[1];
  };
  const called = (prefix: string) =>
    calls.filter((c) => c.join(" ").startsWith(prefix));
  return { runner, calls, called };
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>;

function capture(deps: OrcaToolsDeps) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, Handler>();
  server.tool = ((...args: unknown[]) => {
    tools.set(args[0] as string, args[3] as Handler);
  }) as typeof server.tool;
  registerOrcaTools(server, deps);
  return async (name: string, args: Record<string, unknown>) => {
    const r = await tools.get(name)!(args);
    const text = r.content[0]!.text;
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    return { text, data: m ? JSON.parse(m[1]!) : undefined };
  };
}

const RUN = "run_f74310f49e3b";
const HOLDER = "term_66fae77e-858c-4ad2-a392-99ab04b4cd13";
const ME = "term_me-0000";

// --------------------------------------------------------------- orca_reply

describe("orca_reply", () => {
  it("runs orchestration reply with --run/--id/--body and --retry-request", async () => {
    const orca = fakeOrca([
      ["orchestration reply", ok({ message: { id: "msg_reply1" } })],
    ]);
    const call = capture({ runner: orca.runner, env: {} });
    const r = await call("orca_reply", {
      run_id: RUN,
      message_id: "msg_q1",
      body: "Use option B.",
    });
    const [args] = orca.called("orchestration reply");
    expect(args).toBeDefined();
    expect(flag(args!, "--run")).toBe(RUN);
    expect(flag(args!, "--id")).toBe("msg_q1");
    expect(flag(args!, "--body")).toBe("Use option B.");
    expect(flag(args!, "--retry-request")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.data.ok).toBe(true);
    expect(r.data.reply_message_id).toBe("msg_reply1");
    expect(r.text).toContain("msg_reply1");
  });

  it("surfaces Orca's error", async () => {
    const orca = fakeOrca([
      ["orchestration reply", fail("message_not_found", "no such message")],
    ]);
    const call = capture({ runner: orca.runner, env: {} });
    const r = await call("orca_reply", {
      run_id: RUN,
      message_id: "msg_x",
      body: "hi",
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("message_not_found");
  });
});

// Nudge (2026-11-09): a worker that stopped without reporting gets guidance
// through a Sentinal tool instead of a raw `orchestration send`.
describe("orca_reply to a dispatch", () => {
  it("sends guidance to dispatch:<id> when given dispatch_id instead of message_id", async () => {
    const orca = fakeOrca([
      ["orchestration send", ok({ message: { id: "msg_nudge" } })],
    ]);
    const call = capture({ runner: orca.runner, env: {} });
    const r = await call("orca_reply", {
      run_id: RUN,
      dispatch_id: "ctx_abc",
      body: "Your test run already finished; read its output and report.",
    });
    const [args] = orca.called("orchestration send");
    expect(flag(args!, "--to")).toBe("dispatch:ctx_abc");
    expect(flag(args!, "--run")).toBe(RUN);
    expect(flag(args!, "--subject")).toBeTruthy();
    expect(flag(args!, "--body")).toContain("already finished");
    expect(flag(args!, "--retry-request")).toMatch(/^[0-9a-f-]{36}$/);
    expect(orca.called("orchestration reply")).toEqual([]);
    expect(r.data.ok).toBe(true);
    expect(r.data.dispatch_id).toBe("ctx_abc");
  });

  it("refuses when neither or both of message_id and dispatch_id are given", async () => {
    const orca = fakeOrca([]);
    const call = capture({ runner: orca.runner, env: {} });
    const none = await call("orca_reply", { run_id: RUN, body: "x" });
    const both = await call("orca_reply", {
      run_id: RUN,
      message_id: "m",
      dispatch_id: "d",
      body: "x",
    });
    expect(none.data.ok).toBe(false);
    expect(both.data.ok).toBe(false);
    expect(orca.calls).toEqual([]);
  });
});

// -------------------------------------------------------------- orca_rebind

function rebindRoutes(terminal: Reply) {
  return fakeOrca([
    ["orchestration run-show", out(fixture("run-show.json"))],
    ["terminal show", terminal],
    ["orchestration run-use", ok({ run: { id: RUN, coordinator_handle: ME } })],
  ]);
}

describe("orca_rebind", () => {
  it("answers already bound without a mutation when the Run is ours", async () => {
    const orca = rebindRoutes(out(fixture("terminal-show-live.json")));
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: HOLDER },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(true);
    expect(r.data.already_bound).toBe(true);
    expect(flag(orca.called("orchestration run-show")[0]!, "--id")).toBe(RUN);
    expect(orca.called("terminal show")).toHaveLength(0);
    expect(orca.called("orchestration run-use")).toHaveLength(0);
  });

  it("refuses when another live coordinator holds the Run", async () => {
    const orca = rebindRoutes(out(fixture("terminal-show-live.json")));
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("rebind_refused");
    expect(flag(orca.called("terminal show")[0]!, "--terminal")).toBe(HOLDER);
    expect(orca.called("orchestration run-use")).toHaveLength(0);
  });

  it("rebinds over a live coordinator with force", async () => {
    const orca = rebindRoutes(out(fixture("terminal-show-live.json")));
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN, force: true });
    expect(r.data.ok).toBe(true);
    expect(r.data.previous_coordinator).toBe(HOLDER);
    const [use] = orca.called("orchestration run-use");
    expect(flag(use!, "--id")).toBe(RUN);
    expect(flag(use!, "--retry-request")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rebinds when the previous coordinator terminal is stale", async () => {
    const orca = rebindRoutes(out(fixture("terminal-show-stale.json"), 1));
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(true);
    expect(r.data.bound).toBe(true);
    expect(r.data.previous_coordinator).toBe(HOLDER);
    expect(orca.called("orchestration run-use")).toHaveLength(1);
  });

  it("rebinds when the previous terminal is disconnected", async () => {
    const orca = rebindRoutes(
      ok({ terminal: { handle: HOLDER, connected: false } }),
    );
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(true);
    expect(orca.called("orchestration run-use")).toHaveLength(1);
  });

  it("rebinds a Run with no coordinator without terminal show", async () => {
    const orca = fakeOrca([
      [
        "orchestration run-show",
        ok({ run: { id: RUN, coordinator_handle: null } }),
      ],
      ["orchestration run-use", ok({ run: { id: RUN } })],
    ]);
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(true);
    expect(r.data.previous_coordinator).toBeNull();
    expect(orca.called("orchestration run-use")).toHaveLength(1);
  });

  it("fails with not_in_orca_terminal without a handle", async () => {
    const orca = rebindRoutes(out(fixture("terminal-show-stale.json"), 1));
    const call = capture({ runner: orca.runner, env: {} });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("not_in_orca_terminal");
    expect(orca.called("orchestration run-use")).toHaveLength(0);
  });

  it("surfaces a run-show error as the failure", async () => {
    const orca = fakeOrca([
      ["orchestration run-show", fail("run_not_found", "no such run")],
    ]);
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("run_not_found");
    expect(orca.calls).toHaveLength(1);
  });

  it("surfaces a run-use error as the failure", async () => {
    const orca = fakeOrca([
      ["orchestration run-show", out(fixture("run-show.json"))],
      ["terminal show", out(fixture("terminal-show-stale.json"), 1)],
      ["orchestration run-use", fail("run_not_found", "gone")],
    ]);
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("run_not_found");
  });
});

describe("orca_rebind — fails closed on an unverifiable holder (review should_fix)", () => {
  const unverifiable = out(
    JSON.stringify({
      id: "x",
      ok: false,
      error: { code: "runtime_error", message: "boom" },
    }),
    1,
  );

  it("refuses when terminal show errors with anything but terminal_handle_stale", async () => {
    for (const reply of [
      unverifiable,
      { exitCode: 137, stdout: "", stderr: "", timedOut: true },
    ] as Reply[]) {
      const orca = rebindRoutes(reply);
      const call = capture({
        runner: orca.runner,
        env: { ORCA_TERMINAL_HANDLE: ME },
      });
      const r = await call("orca_rebind", { run_id: RUN });
      expect(r.data.ok).toBe(false);
      expect(r.data.error.code).toBe("rebind_unverified");
      expect(orca.called("orchestration run-use")).toHaveLength(0);
    }
  });

  it("rebinds anyway with force", async () => {
    const orca = rebindRoutes(unverifiable);
    const call = capture({
      runner: orca.runner,
      env: { ORCA_TERMINAL_HANDLE: ME },
    });
    const r = await call("orca_rebind", { run_id: RUN, force: true });
    expect(r.data.ok).toBe(true);
    expect(orca.called("orchestration run-use")).toHaveLength(1);
  });
});
