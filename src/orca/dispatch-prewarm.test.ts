/**
 * Pre-warmed start (Task 2 of docs/plans/2026-09-30-orca-prewarmed-start.md).
 * Real Orca captures replayed through a strictly ordered fake runner — never
 * the real `orca`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import {
  closeTerminal,
  prewarmAgents,
  prewarmTerminal,
  requestOutcome,
  usePrewarm,
} from "./dispatch-prewarm.js";
import { startTask } from "./dispatch-start.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const raw = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");
const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const fx = (name: string): OrcaRunOutput => out(raw(name));
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));

const HANDLE = "term_f7d0cbc5-a48b-42ed-89b1-2c2a1a1cbd7c";
const WT = "/wt/phase-1";

function queue(steps: Array<[string, OrcaRunOutput]>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const next = steps.shift();
    const line = args.join(" ");
    if (!next || !line.startsWith(next[0])) {
      throw new Error(`unexpected orca call: ${line} (wanted ${next?.[0]})`);
    }
    return next[1];
  };
  return { runner, calls, remaining: steps };
}

/** Instant fake clock: every sleep advances time, nothing really waits. */
function fakeTime() {
  let t = 0;
  return {
    clock: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

describe("prewarmAgents / usePrewarm", () => {
  it("defaults to opencode; `none` or empty disables; commas list several", () => {
    expect(prewarmAgents({})).toEqual(["opencode"]);
    expect(prewarmAgents({ SENTINAL_ORCA_PREWARM_AGENTS: "none" })).toEqual([]);
    expect(prewarmAgents({ SENTINAL_ORCA_PREWARM_AGENTS: " " })).toEqual([]);
    expect(
      prewarmAgents({ SENTINAL_ORCA_PREWARM_AGENTS: "opencode, crush" }),
    ).toEqual(["opencode", "crush"]);
  });

  it("pre-warms only a listed agent into an existing worktree", () => {
    const list = ["opencode"];
    expect(usePrewarm("opencode", { path: WT }, list)).toBe(true);
    expect(usePrewarm("opencode", "current", list)).toBe(true);
    expect(usePrewarm("opencode", "new-child", list)).toBe(false);
    expect(usePrewarm("claude", { path: WT }, list)).toBe(false);
    expect(usePrewarm("opencode", { path: WT }, [])).toBe(false);
  });
});

describe("prewarmTerminal", () => {
  it("creates the agent terminal, waits for tui-idle, polls until the input box is drawn, then waits the slack", async () => {
    const q = queue([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", ok({ terminal: { tail: ["  booting…"] } })],
      ["terminal read", fx("terminal-read-home.json")],
    ]);
    const time = fakeTime();
    const created: string[] = [];
    const r = await prewarmTerminal({
      placement: { path: WT },
      agent: "opencode",
      taskId: "task_1",
      runner: q.runner,
      onCreated: (h) => created.push(h),
      ...time,
    });
    expect(r).toMatchObject({ ok: true, handle: HANDLE });
    expect(created).toEqual([HANDLE]);
    expect(q.remaining.length).toBe(0);
    const [create, wait, read] = q.calls;
    expect(flag(create!, "--worktree")).toBe(`path:${WT}`);
    expect(flag(create!, "--command")).toBe("opencode");
    expect(flag(wait!, "--for")).toBe("tui-idle");
    expect(flag(read!, "--terminal")).toBe(HANDLE);
    expect(read).toContain("--screen");
    // 500 ms poll + 1 s slack on the fake clock
    expect(time.clock()).toBeGreaterThanOrEqual(1_500);
  });

  it("gives up when the input box never appears, returning the handle to close", async () => {
    const steps: Array<[string, OrcaRunOutput]> = [
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
    ];
    for (let i = 0; i < 100; i++) {
      steps.push(["terminal read", fx("terminal-read-conversation.json")]);
    }
    const q = queue(steps);
    const r = await prewarmTerminal({
      placement: "current",
      agent: "opencode",
      taskId: "task_1",
      runner: q.runner,
      timeoutMs: 3_000,
      ...fakeTime(),
    });
    expect(r).toMatchObject({ ok: false, handle: HANDLE });
    if (!r.ok) expect(r.reason).toContain("input box");
  });

  it("reports a failed terminal create with no handle", async () => {
    const q = queue([
      [
        "terminal create",
        out(
          JSON.stringify({
            id: "x",
            ok: false,
            error: { code: "worktree_not_found", message: "no worktree" },
          }),
          1,
        ),
      ],
    ]);
    const r = await prewarmTerminal({
      placement: { path: WT },
      agent: "opencode",
      taskId: "task_1",
      runner: q.runner,
      ...fakeTime(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.handle).toBeUndefined();
  });
});

describe("closeTerminal / requestOutcome", () => {
  it("closes exactly the given handle", async () => {
    const q = queue([["terminal close", ok({ closed: true })]]);
    expect(await closeTerminal(HANDLE, q.runner)).toEqual({ ok: true });
    expect(flag(q.calls[0]!, "--terminal")).toBe(HANDLE);
  });

  it("reads request-show states", async () => {
    const a = queue([
      ["orchestration request-show", fx("request-show-completed.json")],
    ]);
    expect((await requestOutcome("r1", a.runner)).state).toBe("completed");
    const b = queue([
      ["orchestration request-show", fx("request-show-absent.json")],
    ]);
    expect((await requestOutcome("r2", b.runner)).state).toBe("absent");
  });
});

// ------------------------------------------------ startTask, pre-warmed path

const readyTerminalStart = () => fx("worker-start-terminal-ready.json");
const PREWARM = { prewarmAgents: ["opencode"], preflight: false } as const;

describe("startTask — pre-warmed", () => {
  it("starts into the pre-warmed terminal with --terminal and no --agent (Truth 1)", async () => {
    const time = fakeTime();
    const q = queue([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", readyTerminalStart()],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      prewarmClock: time,
    });
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    expect(r.startPath).toBe("prewarmed");
    expect(r.prewarm?.terminal).toBe(HANDLE);
    const ws = q.calls.at(-1)!;
    expect(flag(ws, "--terminal")).toBe(HANDLE);
    expect(flag(ws, "--worktree")).toBe(`path:${WT}`);
    expect(ws).not.toContain("--agent");
  });

  it("closes its terminal and falls back to --agent when the box never appears (Truth 2)", async () => {
    const steps: Array<[string, OrcaRunOutput]> = [
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
    ];
    for (let i = 0; i < 61; i++) {
      steps.push(["terminal read", fx("terminal-read-conversation.json")]);
    }
    steps.push(["terminal close", ok({ closed: true })]);
    steps.push(["orchestration worker-start", fx("worker-start-ready.json")]);
    const q = queue(steps);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      prewarmClock: fakeTime(),
    });
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    expect(r.startPath).toBe("agent-fallback");
    expect(r.fallbackReason).toContain("input box");
    const close = q.calls.find((c) => c[1] === "close")!;
    expect(flag(close, "--terminal")).toBe(HANDLE);
    const ws = q.calls.at(-1)!;
    expect(flag(ws, "--agent")).toBe("opencode");
    expect(ws).not.toContain("--terminal");
  });

  it("uses --agent directly when the agent is not listed (Truth 3)", async () => {
    const q = queue([
      ["orchestration worker-start", fx("worker-start-ready.json")],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "claude",
      runner: q.runner,
      ...PREWARM,
    });
    expect(r.status === "started" && r.startPath).toBe("agent");
  });

  it("reuses a known terminal on an in-process replay (same argv, no second create)", async () => {
    const q = queue([["orchestration worker-start", readyTerminalStart()]]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      requestId: "11111111-2222-3333-4444-555555555555",
      terminal: HANDLE,
    });
    expect(r.status).toBe("started");
    const ws = q.calls[0]!;
    expect(flag(ws, "--terminal")).toBe(HANDLE);
    expect(flag(ws, "--retry-request")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("a replay with no local record never pre-warms: request-show absent → unknown, nothing started", async () => {
    const q = queue([
      ["orchestration request-show", fx("request-show-absent.json")],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      requestId: "9ad186c7-fed5-4610-b667-caecc9e36fdc",
      replay: true,
    });
    expect(r.status).toBe("error");
    if (r.status === "error")
      expect(r.error.code).toBe("start_outcome_unknown");
    expect(q.calls.map((c) => c[1])).toEqual(["request-show"]);
  });

  it("a replay with no local record returns the recorded receipt when request-show says completed", async () => {
    const receipt = JSON.parse(raw("worker-start-terminal-ready.json")).result;
    const q = queue([
      [
        "orchestration request-show",
        ok({ requestId: "r", state: "completed", receipt }),
      ],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      requestId: "r",
      replay: true,
    });
    expect(r.status === "started" && r.startPath).toBe("replayed");
  });

  it("a failed pre-warmed attempt: release, close only after a settled answer, retry with a fresh terminal", async () => {
    const failed = JSON.parse(raw("worker-start-failed.json"));
    const time = fakeTime();
    const q = queue([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", out(JSON.stringify(failed), 1)],
      ["orchestration worker-release", ok({ state: "released" })],
      ["terminal close", ok({ closed: true })],
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", readyTerminalStart()],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      prewarmClock: time,
    });
    expect(q.remaining.length).toBe(0);
    expect(r.status === "started" && r.retried).toBe(true);
    expect(q.calls.filter((c) => c[1] === "create").length).toBe(2);
    expect(q.calls.filter((c) => c[1] === "close").length).toBe(1);
  });

  it("never closes after release_unknown (reports instead)", async () => {
    const failed = JSON.parse(raw("worker-start-failed.json"));
    const q = queue([
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", out(JSON.stringify(failed), 1)],
      [
        "orchestration worker-release",
        ok({ state: "release_unknown", recovery: "inspect" }),
      ],
      ["terminal create", fx("terminal-create.json")],
      ["terminal wait", fx("terminal-wait-tui-idle.json")],
      ["terminal read", fx("terminal-read-home.json")],
      ["orchestration worker-start", readyTerminalStart()],
    ]);
    const r = await startTask({
      taskId: "task_1",
      worktree: { path: WT },
      agent: "opencode",
      runner: q.runner,
      ...PREWARM,
      prewarmClock: fakeTime(),
    });
    expect(q.calls.some((c) => c[1] === "close")).toBe(false);
    expect(r.status).toBe("started");
    if (r.status === "started") {
      expect(r.failedAttempts[0]!.cleanup.unclosedTerminals).toContainEqual(
        expect.objectContaining({ id: HANDLE }),
      );
    }
  });
});
