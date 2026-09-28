/**
 * `orca_*` MCP tools — status, dispatch and start (settlement tools are in
 * `mcp-tools-settle.test.ts`). Every test drives a fake runner; the real
 * `orca` binary is never spawned.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeTmpDir } from "../test-helpers.js";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { registerOrcaTools, type OrcaToolsDeps } from "./mcp-tools.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const COORD = "term_66fae77e-858c-4ad2-a392-99ab04b4cd13";

const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));
const fail = (code: string, message: string, data?: unknown) =>
  out(
    JSON.stringify({ id: "x", ok: false, error: { code, message, data } }),
    1,
  );

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

function capture(deps: OrcaToolsDeps) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, { description: string; handler: Handler }>();
  server.tool = ((...args: unknown[]) => {
    tools.set(args[0] as string, {
      description: args[1] as string,
      handler: args[3] as Handler,
    });
  }) as typeof server.tool;
  registerOrcaTools(server, deps);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools.get(name)!.handler(args);
    const text = r.content[0]!.text;
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    return { text, data: m ? JSON.parse(m[1]!) : undefined };
  };
  return { tools, call };
}

const ORCA_ENV = { ORCA_TERMINAL_HANDLE: COORD };

describe("registerOrcaTools", () => {
  it("registers every orca_* tool", () => {
    const { tools } = capture({ runner: fakeOrca([]).runner, env: {} });
    expect([...tools.keys()].sort()).toEqual([
      "orca_ack",
      "orca_dispatch",
      "orca_release",
      "orca_remove_worktree",
      "orca_start",
      "orca_status",
      "orca_stop",
      "orca_wait",
    ]);
  });

  it("labels destructive tools and states the domain is direct-only", () => {
    const { tools } = capture({ runner: fakeOrca([]).runner, env: {} });
    for (const name of ["orca_stop", "orca_release", "orca_remove_worktree"]) {
      expect(tools.get(name)!.description).toContain("DESTRUCTIVE");
    }
    for (const name of ["orca_status", "orca_dispatch", "orca_wait"]) {
      expect(tools.get(name)!.description).not.toContain("DESTRUCTIVE");
    }
    expect(tools.get("orca_status")!.description.toLowerCase()).toContain(
      "direct",
    );
  });
});

// ------------------------------------------------------------ orca_status

describe("orca_status", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("resolves to subagents outside an Orca terminal without probing orca status", async () => {
    const f = fakeOrca([]);
    const { call } = capture({ runner: f.runner, env: {} });
    const r = await call("orca_status", { scope: "master", agent: "opencode" });
    expect(r.data.mode).toBe("subagents");
    expect(r.data.reason).toContain("ORCA_TERMINAL_HANDLE");
    expect(r.data.detection.available).toBe(false);
    expect(r.data.auth).toMatchObject({ ok: true, agent: "opencode" });
    expect(f.called("status")).toEqual([]);
  });

  it("picks Orca for a master plan inside a ready Orca terminal", async () => {
    const f = fakeOrca([["status", out(fixture("status-ready.json"))]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_status", { scope: "master", agent: "opencode" });
    expect(r.data.mode).toBe("orca");
    expect(r.data.detection.terminalHandle).toBe(COORD);
    expect(r.data.detection.appVersion).toBe("1.4.215");
    expect(r.text).toContain("orca");
  });

  it("honours the plan header read from plan_path", async () => {
    dir = makeTmpDir("orca-status");
    const plan = join(dir, "2026-01-01-x.md");
    writeFileSync(
      plan,
      "# X\n\nStatus: PENDING\nApproved: Yes\nOrchestration: subagents\n\n## Tasks\n",
    );
    const f = fakeOrca([["status", out(fixture("status-ready.json"))]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_status", {
      scope: "master",
      agent: "opencode",
      plan_path: plan,
    });
    expect(r.data.mode).toBe("subagents");
    expect(r.data.plan_header).toBe("subagents");
    expect(r.data.reason).toContain("plan header");
  });

  it("single plans stay on subagents without the header (opt-in)", async () => {
    const f = fakeOrca([["status", out(fixture("status-ready.json"))]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_status", { scope: "plan", agent: "opencode" });
    expect(r.data.mode).toBe("subagents");
    expect(r.data.reason).toContain("opt-in");
  });

  it("reports an unreadable plan_path instead of throwing", async () => {
    const f = fakeOrca([["status", out(fixture("status-ready.json"))]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_status", {
      scope: "master",
      agent: "opencode",
      plan_path: "/nonexistent/plan.md",
    });
    expect(r.data.plan_error).toBeTruthy();
    expect(r.data.mode).toBe("orca");
  });

  it("reports a stale claude login", async () => {
    const f = fakeOrca([
      ["status", out(fixture("status-ready.json"))],
      ["account list", out(fixture("account-list-stale-token.json"))],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_status", { scope: "master", agent: "claude" });
    expect(r.data.auth).toMatchObject({ ok: false, reason: "stale-token" });
    expect(r.text).toContain("stale-token");
  });
});

// ---------------------------------------------------------- orca_dispatch

const RUN = {
  id: "run_1",
  coordinator_handle: COORD,
};

function dispatchRoutes(extra: Array<[string, Reply]> = []) {
  let n = 0;
  return fakeOrca([
    ...extra,
    ["orchestration run-current", ok({ run: null })],
    ["orchestration run-create", ok({ run: RUN })],
    [
      "orchestration task-create",
      () => {
        n += 1;
        return ok({ task: { id: `task_${n}`, status: "ready" } });
      },
    ],
    [
      "worktree create",
      (args) =>
        ok({
          worktree: {
            id: `repo::/wt/${flag(args, "--name")}`,
            branch: flag(args, "--name"),
          },
        }),
    ],
  ]);
}

describe("orca_dispatch", () => {
  it("run_id resumes an existing Run via run-use instead of creating one", async () => {
    const f = dispatchRoutes([["orchestration run-use", ok({ run: RUN })]]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "resume",
      agent: "opencode",
      run_id: RUN.id,
      tasks: [{ key: "a", title: "A", spec: "do A", worktree: "current" }],
    });
    expect(r.data.ok).toBe(true);
    expect(f.called("orchestration run-use")).toHaveLength(1);
    expect(f.called("orchestration run-create")).toHaveLength(0);
  });

  it("creates tasks in dependency order, prepares child worktrees, and starts nothing", async () => {
    const f = dispatchRoutes();
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "ship it",
      agent: "opencode",
      tasks: [
        {
          key: "b",
          title: "B",
          spec: "do B",
          deps: ["a"],
          worktree: "current",
        },
        {
          key: "a",
          title: "A",
          spec: "do A",
          worktree: "prepare-child",
          name: "spec-a",
          base_branch: "main",
        },
      ],
    });
    expect(r.data.ok).toBe(true);
    expect(r.data.run_id).toBe("run_1");
    const creates = f.called("orchestration task-create");
    expect(creates.map((c) => flag(c, "--task-title"))).toEqual(["A", "B"]);
    expect(flag(creates[1]!, "--deps")).toBe(JSON.stringify(["task_1"]));
    const byKey = Object.fromEntries(
      r.data.tasks.map((t: { key: string }) => [t.key, t]),
    );
    expect(byKey.a).toMatchObject({
      task_id: "task_1",
      status: "awaiting_start",
      worktree: { path: "/wt/spec-a", branch: "spec-a" },
    });
    expect(byKey.a.next).toContain("worktree_ensure");
    expect(byKey.b).toMatchObject({
      task_id: "task_2",
      deps: ["task_1"],
      placement: "current",
    });
    expect(f.called("orchestration worker-start")).toEqual([]);
    const wt = f.called("worktree create")[0]!;
    expect(flag(wt, "--base-branch")).toBe("main");
    expect(flag(wt, "--setup")).toBe("skip");
  });

  it("passes an existing task id through as a dependency", async () => {
    const f = dispatchRoutes();
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    await call("orca_dispatch", {
      objective: "o",
      agent: "opencode",
      tasks: [
        {
          key: "x",
          title: "X",
          spec: "s",
          deps: ["task_old"],
          worktree: { path: "/p" },
        },
      ],
    });
    const c = f.called("orchestration task-create")[0]!;
    expect(flag(c, "--deps")).toBe(JSON.stringify(["task_old"]));
  });

  it.each([
    [
      "duplicate keys",
      [
        { key: "a", title: "A", spec: "s", worktree: "current" },
        { key: "a", title: "A2", spec: "s", worktree: "current" },
      ],
    ],
    [
      "a dependency cycle",
      [
        { key: "a", title: "A", spec: "s", deps: ["b"], worktree: "current" },
        { key: "b", title: "B", spec: "s", deps: ["a"], worktree: "current" },
      ],
    ],
    [
      "prepare-child without base_branch",
      [
        {
          key: "a",
          title: "A",
          spec: "s",
          worktree: "prepare-child",
          name: "n",
        },
      ],
    ],
    ["no tasks", []],
  ])("refuses %s before touching Orca", async (_label, tasks) => {
    const f = dispatchRoutes();
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "o",
      agent: "opencode",
      tasks,
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("invalid_tasks");
    expect(f.calls).toEqual([]);
  });

  it("refuses a Run bound to another coordinator (Pre-Mortem 3)", async () => {
    const f = dispatchRoutes([
      [
        "orchestration run-current",
        ok({ run: { id: "run_x", coordinator_handle: "term_other" } }),
      ],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "o",
      agent: "opencode",
      tasks: [{ key: "a", title: "A", spec: "s", worktree: "current" }],
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("coordinator_mismatch");
    expect(f.called("orchestration task-create")).toEqual([]);
  });

  it("refuses an agent whose login is unhealthy before creating a Run", async () => {
    const f = dispatchRoutes([
      ["account list", out(fixture("account-list-stale-token.json"))],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "o",
      agent: "claude",
      tasks: [{ key: "a", title: "A", spec: "s", worktree: "current" }],
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("agent_auth");
    expect(f.called("orchestration run-")).toEqual([]);
  });

  it("returns the tasks created so far when a later task-create fails", async () => {
    let n = 0;
    const f = fakeOrca([
      ["orchestration run-current", ok({ run: RUN })],
      [
        "orchestration task-create",
        () => {
          n += 1;
          return n === 1
            ? ok({ task: { id: "task_1" } })
            : fail("invalid_argument", "boom");
        },
      ],
    ]);
    const { call } = capture({ runner: f.runner, env: ORCA_ENV });
    const r = await call("orca_dispatch", {
      objective: "o",
      agent: "opencode",
      tasks: [
        { key: "a", title: "A", spec: "s", worktree: "current" },
        { key: "b", title: "B", spec: "s", worktree: "current" },
      ],
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.message).toContain("boom");
    expect(r.data.tasks.map((t: { key: string }) => t.key)).toEqual(["a"]);
    expect(r.data.run_reused).toBe(true);
  });
});
