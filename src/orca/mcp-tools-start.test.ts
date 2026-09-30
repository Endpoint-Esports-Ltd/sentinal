/**
 * `orca_start` — the start budget, in-process join and Orca replay (other
 * tools: `mcp-tools.test.ts`, `mcp-tools-settle.test.ts`). Fake runner only; the real
 * `orca` binary is never spawned.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { registerOrcaStartTool } from "./mcp-tools-start.js";
import {
  createOrcaToolState,
  type OrcaToolState,
  type OrcaToolsDeps,
} from "./mcp-tools-shared.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const COORD = "term_66fae77e-858c-4ad2-a392-99ab04b4cd13";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));

type Reply =
  OrcaRunOutput | ((args: string[]) => OrcaRunOutput | Promise<OrcaRunOutput>);

/** Prefix-routed fake `orca`; unknown commands throw (never the real binary). */
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

function capture(
  deps: OrcaToolsDeps,
  state: OrcaToolState = createOrcaToolState(),
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, { description: string; handler: Handler }>();
  server.tool = ((...args: unknown[]) => {
    tools.set(args[0] as string, {
      description: args[1] as string,
      handler: args[3] as Handler,
    });
  }) as typeof server.tool;
  registerOrcaStartTool(server, deps, state);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools.get(name)!.handler(args);
    const text = r.content[0]!.text;
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    return { text, data: m ? JSON.parse(m[1]!) : undefined };
  };
  return { tools, call };
}

/** Pre-warm off: these tests exercise the plain `--agent` start. */
const ORCA_ENV = {
  ORCA_TERMINAL_HANDLE: COORD,
  SENTINAL_ORCA_PREWARM_AGENTS: "none",
};

// ------------------------------------------------------------- orca_start

const readyReceipt = (dispatchId = "ctx_1") =>
  ok({
    runId: "run_1",
    taskId: "task_1",
    dispatchId,
    state: "ready",
    stage: "input_accepted",
    residualResources: [],
  });

describe("orca_start", () => {
  it("starts one worker with path placement and the given request id", async () => {
    const f = fakeOrca([["orchestration worker-start", readyReceipt()]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const rid = "11111111-2222-3333-4444-555555555555";
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
      request_id: rid,
    });
    expect(r.data).toMatchObject({
      status: "started",
      dispatch_id: "ctx_1",
      request_id: rid,
    });
    const ws = f.called("orchestration worker-start")[0]!;
    expect(flag(ws, "--worktree")).toBe("path:/wt/a");
    expect(flag(ws, "--agent")).toBe("opencode");
    expect(flag(ws, "--retry-request")).toBe(rid);
  });

  it("mints a UUID request id when none is given", async () => {
    const f = fakeOrca([["orchestration worker-start", readyReceipt()]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
    });
    expect(r.data.request_id).toMatch(UUID);
    const ws = f.called("orchestration worker-start")[0]!;
    expect(flag(ws, "--worktree")).toBe("current");
    expect(flag(ws, "--retry-request")).toBe(r.data.request_id);
  });

  it("returns pending past the budget and joins the same in-flight start on replay", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeOrca([
      [
        "orchestration worker-start",
        async () => {
          await gate;
          return readyReceipt("ctx_slow");
        },
      ],
    ]);
    const { call } = capture({
      runner: f.runner,
      env: ORCA_ENV,
      startBudgetMs: 30,
    });
    const first = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
    });
    expect(first.data.status).toBe("pending");
    expect(first.data.request_id).toMatch(UUID);
    expect(first.text).toContain("orca_start");

    release();
    const second = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
      request_id: first.data.request_id,
    });
    expect(second.data).toMatchObject({
      status: "started",
      dispatch_id: "ctx_slow",
    });
    // Joined in-process: Orca saw ONE worker-start.
    expect(f.called("orchestration worker-start").length).toBe(1);
  });

  it("a pending retry_of start names retry_of in its replay hint and structured result", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeOrca([
      [
        "orchestration worker-start",
        async () => {
          await gate;
          return readyReceipt("ctx_new");
        },
      ],
    ]);
    const { call } = capture({
      runner: f.runner,
      env: ORCA_ENV,
      startBudgetMs: 30,
    });
    const first = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
      retry_of: "ctx_old",
    });
    release();
    expect(first.data.status).toBe("pending");
    expect(first.data.retry_of).toBe("ctx_old");
    expect(first.text).toContain('retry_of="ctx_old"');
  });

  it("replays through Orca (--retry-request) when no start is in flight here", async () => {
    const f = fakeOrca([["orchestration worker-start", readyReceipt()]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const rid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
      request_id: rid,
    });
    const ws = f.called("orchestration worker-start")[0]!;
    expect(flag(ws, "--retry-request")).toBe(rid);
  });

  it("maps a CLI timeout on the first attempt to pending (replayable)", async () => {
    const f = fakeOrca([
      [
        "orchestration worker-start",
        { exitCode: 137, stdout: "", stderr: "", timedOut: true },
      ],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
    });
    expect(r.data.status).toBe("pending");
    expect(r.data.request_id).toMatch(UUID);
  });

  it("reports unmet dependencies as blocked and tells the caller to use a fresh request", async () => {
    const f = fakeOrca([
      [
        "orchestration worker-start",
        out(fixture("worker-start-not-startable.json"), 1),
      ],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_b",
      worktree: "current",
      agent: "opencode",
    });
    expect(r.data.status).toBe("blocked");
    expect(r.data.unmet_dependencies.length).toBeGreaterThan(0);
    expect(r.text).toContain("without request_id");
  });

  it("passes retry_of through as --retry-of, keeping the request id", async () => {
    const f = fakeOrca([["orchestration worker-start", readyReceipt()]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const rid = "11111111-2222-3333-4444-555555555555";
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
      request_id: rid,
      retry_of: "ctx_old",
    });
    expect(r.data.status).toBe("started");
    const ws = f.called("orchestration worker-start")[0]!;
    expect(flag(ws, "--retry-of")).toBe("ctx_old");
    expect(flag(ws, "--retry-request")).toBe(rid);
  });

  it("reports delivery_confirmed: true for a confirmed receipt", async () => {
    const f = fakeOrca([["orchestration worker-start", readyReceipt()]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
    });
    expect(r.data.delivery_confirmed).toBe(true);
    expect(r.text).not.toContain("cannot confirm");
  });

  it("reports delivery_confirmed: false and the never-started hint when Orca cannot observe delivery", async () => {
    const f = fakeOrca([
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_8b3fb8fed05a",
      worktree: "current",
      agent: "opencode",
    });
    expect(r.data.delivery_confirmed).toBe(false);
    expect(r.text).toContain(
      "Orca cannot confirm this agent received the brief; orca_wait reports a never-started stall if it did not.",
    );
  });

  it("describes retry_of and no longer claims to close terminals", () => {
    const f = fakeOrca([]);
    const { tools } = capture({ runner: f.runner, env: ORCA_ENV });
    const d = tools.get("orca_start")!.description;
    expect(d).toContain("retry_of");
    expect(d).toContain("residual terminals reported");
    expect(d).not.toContain("residual terminals closed");
  });

  it("refuses an agent whose login is stale", async () => {
    const f = fakeOrca([
      ["account list", out(fixture("account-list-stale-token.json"))],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "claude",
    });
    expect(r.data.status).toBe("refused");
    expect(f.called("orchestration worker-start")).toEqual([]);
  });
});

// ------------------------------------------------ orca_start, pre-warmed

describe("orca_start — pre-warmed (issue #13)", () => {
  const HANDLE = "term_f7d0cbc5-a48b-42ed-89b1-2c2a1a1cbd7c";
  const fx = (name: string): OrcaRunOutput => out(fixture(name));
  const instant = {
    clock: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
    sleep: async () => {},
  };

  it("pre-warms opencode by default, starts with --terminal and records the terminal Sentinal created", async () => {
    const f = fakeOrca([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", fx("worker-start-terminal-ready.json")],
    ]);
    const state = createOrcaToolState();
    const { call } = capture(
      {
        runner: f.runner,
        env: { ORCA_TERMINAL_HANDLE: COORD },
        prewarmClock: instant,
      },
      state,
    );
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
    });
    expect(r.data).toMatchObject({
      status: "started",
      start_path: "prewarmed",
      prewarm: { terminal: HANDLE },
    });
    const ws = f.called("orchestration worker-start")[0]!;
    expect(flag(ws, "--terminal")).toBe(HANDLE);
    expect(ws).not.toContain("--agent");
    expect(state.createdTerminals.get(r.data.dispatch_id)).toBe(HANDLE);
  });

  it("a pending join never creates a second terminal", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeOrca([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      [
        "orchestration worker-start",
        async () => {
          await gate;
          return fx("worker-start-terminal-ready.json");
        },
      ],
    ]);
    const { call } = capture({
      runner: f.runner,
      env: { ORCA_TERMINAL_HANDLE: COORD },
      startBudgetMs: 30,
      prewarmClock: instant,
    });
    const first = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
    });
    expect(first.data.status).toBe("pending");
    release();
    const second = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
      request_id: first.data.request_id,
    });
    expect(second.data.status).toBe("started");
    expect(f.called("terminal create").length).toBe(1);
  });
});

describe("orca_start — retry_of on a ready task (issue #13)", () => {
  it("reports that retry_of was skipped and the task started plainly", async () => {
    let n = 0;
    const f = fakeOrca([
      [
        "orchestration worker-start",
        () =>
          n++ === 0
            ? out(
                JSON.stringify({
                  id: "x",
                  ok: false,
                  error: {
                    code: "task_not_startable",
                    message: "Task task_1 cannot retry from Dispatch ctx_old.",
                    data: { status: "ready", unmetDependencies: [] },
                  },
                }),
                1,
              )
            : readyReceipt("ctx_new"),
      ],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_start", {
      task_id: "task_1",
      worktree: "current",
      agent: "opencode",
      retry_of: "ctx_old",
    });
    expect(r.data).toMatchObject({
      status: "started",
      dispatch_id: "ctx_new",
      retry_of_skipped: true,
    });
    expect(r.text).toContain("already ready");
  });
});

describe("orca_start — in-process replay after a timeout (review should_fix)", () => {
  const fx = (name: string): OrcaRunOutput => out(fixture(name));
  const instant = { clock: () => 0, sleep: async () => {} };

  it("reuses the recorded pre-warmed terminal under the same request id", async () => {
    let n = 0;
    const f = fakeOrca([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      [
        "orchestration worker-start",
        () =>
          n++ === 0
            ? { exitCode: 137, stdout: "", stderr: "", timedOut: true }
            : fx("worker-start-terminal-ready.json"),
      ],
    ]);
    const state = createOrcaToolState();
    const { call } = capture(
      {
        runner: f.runner,
        env: { ORCA_TERMINAL_HANDLE: COORD },
        prewarmClock: instant,
      },
      state,
    );
    const first = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
    });
    expect(first.data.status).toBe("pending");
    expect(state.startTerminals.size).toBe(1);
    const second = await call("orca_start", {
      task_id: "task_1",
      worktree: { path: "/wt/a" },
      agent: "opencode",
      request_id: first.data.request_id,
    });
    expect(second.data.status).toBe("started");
    expect(f.called("terminal create").length).toBe(1);
    const [a, b] = f.called("orchestration worker-start");
    expect(flag(b!, "--terminal")).toBe(flag(a!, "--terminal"));
    expect(flag(b!, "--retry-request")).toBe(first.data.request_id);
    expect(state.startTerminals.size).toBe(0);
  });
});
