import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import {
  ackDelivery,
  createTask,
  ensureRun,
  prepareChildWorktree,
  releaseWorker,
  removeChildWorktree,
  stopWorker,
  waitForSettlement,
} from "./dispatch.js";
import type { StallVerdict } from "./stall.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): any => JSON.parse(fixture(name));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORD = "term_66fae77e-858c-4ad2-a392-99ab04b4cd13";
const SPIKE_A_PATH = "/Users/dev/orca/workspaces/sentinal/orca-spike-a";

const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));
const envelope = (doc: unknown, exitCode = 0): OrcaRunOutput =>
  out(JSON.stringify(doc), exitCode);

/**
 * Strictly ordered fake: each call must start with the next expected prefix.
 * Never spawns the real `orca`.
 */
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

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const release = (dispatchId: string, state: string, extra = {}) =>
  ok({ dispatchId, state, processAction: "none", ...extra });

describe("ensureRun", () => {
  const bound = (handle: string) =>
    ok({
      run: {
        ...json("run-create.json").result.run,
        coordinator_handle: handle,
      },
    });

  it("reuses the bound Run when its coordinator is ours", async () => {
    const { runner, calls } = queue([
      ["orchestration run-current", bound(COORD)],
    ]);
    const r = await ensureRun({
      objective: "o",
      env: { ORCA_TERMINAL_HANDLE: COORD },
      runner,
    });
    expect(r).toMatchObject({ ok: true, reused: true });
    expect(r.ok && r.run.id).toBe("run_93672f816e9f");
    expect(calls).toEqual([["orchestration", "run-current", "--json"]]);
  });

  it("refuses a bound Run owned by another terminal and never creates one", async () => {
    const { runner, calls } = queue([
      ["orchestration run-current", bound("term_other")],
    ]);
    const r = await ensureRun({
      objective: "o",
      env: { ORCA_TERMINAL_HANDLE: COORD },
      runner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("coordinator_mismatch");
      expect(r.error.message).toContain("term_other");
    }
    expect(calls.length).toBe(1);
  });

  it("resume: with run_id and no Run bound here, binds that Run with run-use (a new session)", async () => {
    const { runner, calls } = queue([
      ["orchestration run-current", ok({ run: null })],
      ["orchestration run-use", bound(COORD)],
    ]);
    const r = await ensureRun({
      objective: "o",
      runId: "run_93672f816e9f",
      env: { ORCA_TERMINAL_HANDLE: COORD },
      runner,
    });
    expect(r).toMatchObject({ ok: true, reused: true });
    const use = calls.find((c) => c[1] === "run-use")!;
    expect(use).toContain("--id");
    expect(use[use.indexOf("--id") + 1]).toBe("run_93672f816e9f");
    expect(calls.some((c) => c[1] === "run-create")).toBe(false);
  });

  it("resume: a different Run already bound here is refused, not silently swapped", async () => {
    const { runner } = queue([["orchestration run-current", bound(COORD)]]);
    const r = await ensureRun({
      objective: "o",
      runId: "run_other",
      env: { ORCA_TERMINAL_HANDLE: COORD },
      runner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("run_mismatch");
  });

  it("creates a Run with a stable retry-request id when none is bound", async () => {
    const { runner, calls } = queue([
      ["orchestration run-current", ok({ run: null })],
      ["orchestration run-create", out(fixture("run-create.json"))],
    ]);
    const r = await ensureRun({
      objective: "ship it",
      env: { ORCA_TERMINAL_HANDLE: COORD },
      runner,
    });
    expect(r).toMatchObject({ ok: true, reused: false });
    expect(flag(calls[1], "--objective")).toBe("ship it");
    expect(flag(calls[1], "--retry-request")).toMatch(UUID);
    expect(r.ok && r.requestId).toBe(flag(calls[1], "--retry-request"));
  });

  it("passes an explicit coordinator handle as --from and replays a given request id", async () => {
    const id = "3e3ec9fa-1cdc-4684-afa1-f183c3e4f906";
    const { runner, calls } = queue([
      ["orchestration run-current --from " + COORD, ok({ run: null })],
      ["orchestration run-create", out(fixture("run-create.json"))],
    ]);
    const r = await ensureRun({
      objective: "o",
      coordinatorHandle: COORD,
      env: {},
      runner,
      requestId: id,
    });
    expect(r.ok).toBe(true);
    expect(flag(calls[1], "--from")).toBe(COORD);
    expect(flag(calls[1], "--retry-request")).toBe(id);
  });

  it("refuses without any coordinator handle", async () => {
    const { runner, calls } = queue([]);
    const r = await ensureRun({ objective: "o", env: {}, runner });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_coordinator_handle");
    expect(calls.length).toBe(0);
  });
});

describe("createTask", () => {
  it("creates a task with deps as a JSON array and a retry-request id", async () => {
    const { runner, calls } = queue([
      ["orchestration task-create", out(fixture("task-create.json"))],
    ]);
    const r = await createTask({
      runId: "run_1",
      title: "Task 1",
      spec: "do it",
      deps: ["task_a"],
      runner,
    });
    expect(r.ok && r.task.id).toBe("task_8b3fb8fed05a");
    expect(flag(calls[0], "--run")).toBe("run_1");
    expect(flag(calls[0], "--spec")).toBe("do it");
    expect(flag(calls[0], "--task-title")).toBe("Task 1");
    expect(flag(calls[0], "--deps")).toBe('["task_a"]');
    expect(flag(calls[0], "--retry-request")).toMatch(UUID);
  });

  it("surfaces Orca's error with the request id for replay", async () => {
    const { runner } = queue([
      ["orchestration task-create", out(fixture("unknown-command.json"), 1)],
    ]);
    const r = await createTask({ runId: "r", title: "t", spec: "s", runner });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_argument");
      expect(r.requestId).toMatch(UUID);
    }
  });
});

describe("prepareChildWorktree", () => {
  const wt = {
    id: `repo-1::${SPIKE_A_PATH}`,
    path: SPIKE_A_PATH,
    branch: "spec-a",
  };

  it("creates a child worktree without an agent and returns its path", async () => {
    const { runner, calls } = queue([
      ["worktree create", ok({ worktree: wt })],
    ]);
    const r = await prepareChildWorktree({
      name: "spec-a",
      baseBranch: "main",
      runner,
    });
    expect(r).toEqual({
      ok: true,
      path: SPIKE_A_PATH,
      worktreeId: wt.id,
      branch: "spec-a",
    });
    expect(calls[0]).toEqual([
      "worktree",
      "create",
      "--name",
      "spec-a",
      "--base-branch",
      "main",
      "--parent-worktree",
      "current",
      "--setup",
      "skip",
      "--json",
    ]);
    expect(calls[0]).not.toContain("--agent");
  });

  it("derives the path from the id, else falls back to worktree show", async () => {
    const a = queue([["worktree create", ok({ worktree: { id: wt.id } })]]);
    const r1 = await prepareChildWorktree({
      name: "spec-a",
      baseBranch: "main",
      runner: a.runner,
    });
    expect(r1.ok && r1.path).toBe(SPIKE_A_PATH);

    const b = queue([
      ["worktree create", ok({ created: true })],
      ["worktree show --worktree name:spec-a", ok({ worktree: wt })],
    ]);
    const r2 = await prepareChildWorktree({
      name: "spec-a",
      baseBranch: "main",
      runner: b.runner,
    });
    expect(r2.ok && r2.worktreeId).toBe(wt.id);
  });

  it("returns an error when neither create nor show yields a path", async () => {
    const { runner } = queue([
      ["worktree create", ok({})],
      ["worktree show", ok({})],
    ]);
    const r = await prepareChildWorktree({
      name: "x",
      baseBranch: "main",
      runner,
    });
    expect(r.ok).toBe(false);
  });
});

describe("waitForSettlement", () => {
  it("treats Orca's timedOut as a checkpoint and parses NDJSON output", async () => {
    const { runner, calls } = queue([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      ["orchestration worker-list", ok({ workers: [] })],
    ]);
    const r = await waitForSettlement({ runId: "run_93672f816e9f", runner });
    expect(r).toMatchObject({
      ok: true,
      timedOut: true,
      deliveryId: null,
      messages: [],
      stalls: [],
    });
    expect(calls[0]).toEqual([
      "orchestration",
      "check",
      "--run",
      "run_93672f816e9f",
      "--wait",
      "--types",
      "worker_done,escalation,question,heartbeat",
      "--timeout-ms",
      "35000",
      "--json",
    ]);
  });

  it("clamps the wait to 40 s", async () => {
    const { runner, calls } = queue([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      ["orchestration worker-list", ok({ workers: [] })],
    ]);
    await waitForSettlement({ runId: "r", timeoutMs: 100_000, runner });
    expect(flag(calls[0], "--timeout-ms")).toBe("40000");
  });

  it("decodes worker_done payloads and does not stall the dispatch that reported", async () => {
    const { runner, calls } = queue([
      ["orchestration check", out(fixture("check-worker-done.json"))],
      [
        "orchestration worker-list",
        ok({
          workers: [
            {
              dispatchId: "ctx_4c968df3149b",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "exited" },
              },
            },
          ],
        }),
      ],
    ]);
    const r = await waitForSettlement({ runId: "run_93672f816e9f", runner });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timedOut).toBe(false);
    expect(r.deliveryId).toBe("delivery_aa54dfdecfad");
    expect(r.messages[0].workerDone).toEqual({
      taskId: "task_8b3fb8fed05a",
      dispatchId: "ctx_4c968df3149b",
      outcome: "succeeded",
      filesModified: ["spike/worker-a.txt"],
    });
    expect(r.messages[0].payload).toMatchObject({ outcome: "succeeded" });
    expect(r.stalls).toEqual([]);
    expect(calls.length).toBe(2);
  });

  it("reports the auth stall of a still-active dispatch", async () => {
    const { runner } = queue([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      [
        "orchestration worker-list",
        ok({
          workers: [
            {
              dispatchId: "ctx_f359d5e49a0b",
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
        out(fixture("worker-read-auth-stall.json")),
      ],
    ]);
    const r = await waitForSettlement({
      runId: "r",
      runner,
      now: 1790618364142 + 1000,
    });
    expect(r.ok && r.stalls.map((s) => [s.dispatchId, s.reason])).toEqual([
      ["ctx_f359d5e49a0b", "auth-error"],
    ]);
  });

  it("returns reclaimable terminals and a never-started stall", async () => {
    const id = "ctx_c8a313c725e8";
    const { runner, calls } = queue([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      [
        "orchestration worker-list",
        ok({
          workers: [
            {
              dispatchId: id,
              taskId: "task_2b47d9bd563a",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "live" },
              },
            },
            {
              dispatchId: "ctx_done",
              taskId: "task_done",
              terminalState: "reclaimable",
              agentTerminalHandle: "term_done",
              projection: { outcome: "succeeded" },
            },
          ],
        }),
      ],
      [
        `orchestration worker-read --dispatch ${id}`,
        out(fixture("worker-read-terminal-home.json")),
      ],
      [
        `orchestration worker-show --dispatch ${id}`,
        out(fixture("worker-show-dispatched.json")),
      ],
    ]);
    const now = Date.parse("2026-09-29T21:46:28Z") + 4 * 60_000;
    const r = await waitForSettlement({ runId: "r", runner, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stalls.map((s) => [s.dispatchId, s.reason])).toEqual([
      [id, "never-started"],
    ]);
    expect(r.reclaimable).toEqual([
      { dispatchId: "ctx_done", taskId: "task_done", terminal: "term_done" },
    ]);
    expect(r.attention).toEqual([]);
    expect(calls.length).toBe(4);

    const later = queue([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      [
        "orchestration worker-list",
        ok({
          workers: [
            {
              dispatchId: id,
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
      [
        "orchestration worker-show",
        out(fixture("worker-show-dispatched.json")),
      ],
    ]);
    const r2 = await waitForSettlement({
      runId: "r",
      runner: later.runner,
      now,
      neverStartedMs: 10 * 60_000,
    });
    expect(r2.ok && r2.stalls).toEqual([]);
  });

  it("keeps the messages when stall collection fails", async () => {
    const { runner } = queue([
      ["orchestration check", out(fixture("check-worker-done.json"))],
      ["orchestration worker-list", out(fixture("unknown-command.json"), 1)],
    ]);
    const r = await waitForSettlement({ runId: "r", runner });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.messages.length).toBe(1);
    expect(r.stallError?.code).toBe("invalid_argument");
    expect(r.reclaimable).toEqual([]);
    expect(r.attention).toEqual([]);
  });

  it("returns the check error", async () => {
    const { runner } = queue([
      ["orchestration check", out(fixture("unknown-command.json"), 1)],
    ]);
    const r = await waitForSettlement({ runId: "r", runner });
    expect(r.ok).toBe(false);
  });
});

describe("ack / stop / release / remove", () => {
  const positive: StallVerdict = {
    dispatchId: "ctx_a",
    stalled: true,
    reason: "auth-error",
    evidence: "401",
  };

  it("acks a delivery with a retry-request id", async () => {
    const { runner, calls } = queue([
      [
        "orchestration check --run r --ack delivery_1",
        out(fixture("check-wait-timeout.ndjson")),
      ],
    ]);
    const r = await ackDelivery({
      runId: "r",
      deliveryId: "delivery_1",
      runner,
    });
    expect(r.ok).toBe(true);
    expect(flag(calls[0], "--retry-request")).toMatch(UUID);
  });

  it("refuses to stop without a positive stall verdict for that dispatch", async () => {
    const { runner, calls } = queue([]);
    const cases: Array<StallVerdict | undefined> = [
      undefined,
      { ...positive, stalled: false, reason: null },
      { ...positive, dispatchId: "ctx_other" },
      { ...positive, reason: null },
      { ...positive, stalled: false },
    ];
    for (const evidence of cases) {
      const r = await stopWorker("ctx_a", {
        evidence: evidence as StallVerdict,
        runner,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("stop_refused");
    }
    expect(calls.length).toBe(0);
  });

  it("stops on positive evidence", async () => {
    const { runner, calls } = queue([
      [
        "orchestration worker-stop --dispatch ctx_a",
        ok({ dispatchId: "ctx_a", state: "stopped" }),
      ],
    ]);
    const r = await stopWorker("ctx_a", { evidence: positive, runner });
    expect(r.ok && r.result.state).toBe("stopped");
    expect(flag(calls[0], "--retry-request")).toMatch(UUID);
  });

  it("reports stop_unknown as an error", async () => {
    const { runner } = queue([
      [
        "orchestration worker-stop",
        envelope(
          {
            id: "x",
            ok: true,
            result: { dispatchId: "ctx_a", state: "stop_unknown" },
          },
          1,
        ),
      ],
    ]);
    const r = await stopWorker("ctx_a", { evidence: positive, runner });
    expect(r.ok).toBe(false);
  });

  it("releases a worker and surfaces release_unknown as an error with recovery", async () => {
    const a = queue([
      [
        "orchestration worker-release --dispatch ctx_a",
        release("ctx_a", "released"),
      ],
    ]);
    const r1 = await releaseWorker("ctx_a", { runner: a.runner });
    expect(r1.ok && r1.result.state).toBe("released");
    expect(flag(a.calls[0], "--retry-request")).toMatch(UUID);

    const b = queue([
      [
        "orchestration worker-release",
        release("ctx_a", "release_unknown", { recovery: "do X" }),
      ],
    ]);
    const r2 = await releaseWorker("ctx_a", { runner: b.runner });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.message).toContain("do X");
  });

  it("removes a child worktree by path, without --force unless asked", async () => {
    const a = queue([["worktree rm", ok({ removed: true })]]);
    await removeChildWorktree("/wt/a", { runner: a.runner });
    expect(a.calls[0]).toEqual([
      "worktree",
      "rm",
      "--worktree",
      "path:/wt/a",
      "--json",
    ]);

    const b = queue([["worktree rm", ok({ removed: true })]]);
    await removeChildWorktree("/wt/a", { runner: b.runner, force: true });
    expect(b.calls[0]).toContain("--force");
  });
});
