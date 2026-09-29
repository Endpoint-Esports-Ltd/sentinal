import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { startTask } from "./dispatch-start.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): any => JSON.parse(fixture(name));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED_DISPATCH = "ctx_854b8828942e";
const FAILED_TERMINAL = "term_d485e936-cfdf-4d58-b6cf-2f28478260e5";
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

function failedReceipt(dispatchId: string, terminal: string): OrcaRunOutput {
  const doc = json("worker-start-failed.json");
  doc.result.dispatchId = dispatchId;
  for (const r of doc.result.residualResources) {
    if (r.kind === "terminal") r.id = terminal;
  }
  return envelope(doc, 1);
}

const release = (dispatchId: string, state: string, extra = {}) =>
  ok({ dispatchId, state, processAction: "none", ...extra });

describe("startTask", () => {
  it("starts a worker at an explicit path with a retry-request id", async () => {
    const { runner, calls } = queue([
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "task_8b3fb8fed05a",
      worktree: { path: "/wt/a" },
      agent: "opencode",
      runner,
    });
    expect(r.status).toBe("started");
    if (r.status === "started") {
      expect(r.dispatchId).toBe("ctx_4c968df3149b");
      expect(r.retried).toBe(false);
    }
    expect(calls.length).toBe(1);
    expect(flag(calls[0], "--task")).toBe("task_8b3fb8fed05a");
    expect(flag(calls[0], "--worktree")).toBe("path:/wt/a");
    expect(flag(calls[0], "--agent")).toBe("opencode");
    expect(flag(calls[0], "--retry-request")).toMatch(UUID);
  });

  it("refuses a claude worker whose login is stale, suggesting opencode or /login", async () => {
    const { runner, calls } = queue([
      ["account list", out(fixture("account-list-stale-token.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "claude",
      runner,
    });
    expect(r.status).toBe("refused");
    if (r.status === "refused") {
      expect(r.message).toContain("opencode");
      expect(r.message).toContain("/login");
    }
    expect(calls.some((c) => c.includes("worker-start"))).toBe(false);
  });

  it("refuses on any ok:false auth, e.g. rate-limited", async () => {
    const { runner } = queue([
      ["account list", out(fixture("account-list-rate-limited.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "claude",
      runner,
    });
    expect(r.status).toBe("refused");
  });

  it("skips the preflight when asked", async () => {
    const { runner, calls } = queue([
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "claude",
      preflight: false,
      runner,
    });
    expect(r.status).toBe("started");
    expect(flag(calls[0], "--worktree")).toBe("current");
  });

  it("failed → reports (never closes) the retained terminal → one --retry-of into the same worktree → ready", async () => {
    const { runner, calls, remaining } = queue([
      [
        "orchestration worker-start",
        failedReceipt(FAILED_DISPATCH, FAILED_TERMINAL),
      ],
      [
        `orchestration worker-release --dispatch ${FAILED_DISPATCH}`,
        release(FAILED_DISPATCH, "retained", {
          reason: "user_takeover",
          recovery: "inspect the terminal",
        }),
      ],
      [`orchestration worker-start`, out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "task_8b3fb8fed05a",
      worktree: "new-child",
      name: "spec-a",
      baseBranch: "main",
      agent: "opencode",
      runner,
    });
    expect(remaining.length).toBe(0);
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    expect(r.retried).toBe(true);
    expect(calls.some((c) => c[0] === "terminal")).toBe(false);
    const cleanup = r.failedAttempts[0].cleanup;
    expect(cleanup.closedTerminals).toEqual([]);
    expect(cleanup.unclosedTerminals).toEqual([
      { id: FAILED_TERMINAL, reason: "retained: user_takeover" },
    ]);
    expect(cleanup.recovery).toBe("inspect the terminal");

    const [first, , retry] = calls;
    expect(flag(first, "--worktree")).toBe("new-child");
    expect(flag(first, "--name")).toBe("spec-a");
    expect(flag(first, "--base-branch")).toBe("main");
    expect(flag(retry, "--retry-of")).toBe(FAILED_DISPATCH);
    expect(flag(retry, "--task")).toBe("task_8b3fb8fed05a");
    expect(flag(retry, "--worktree")).toBe(`path:${SPIKE_A_PATH}`);
    expect(flag(retry, "--agent")).toBe("opencode");
    expect(retry).not.toContain("--name");
    expect(flag(retry, "--retry-request")).toMatch(UUID);
    expect(flag(retry, "--retry-request")).not.toBe(
      flag(first, "--retry-request"),
    );
  });

  it("retry failure: both attempts' terminals reported unclosed, exactly one retry, error returned", async () => {
    const { runner, calls, remaining } = queue([
      [
        "orchestration worker-start",
        failedReceipt(FAILED_DISPATCH, FAILED_TERMINAL),
      ],
      ["orchestration worker-release", release(FAILED_DISPATCH, "retained")],
      [
        "orchestration worker-start",
        failedReceipt("ctx_second", "term_second"),
      ],
      [
        "orchestration worker-release --dispatch ctx_second",
        release("ctx_second", "retained"),
      ],
    ]);
    const r = await startTask({
      taskId: "task_8b3fb8fed05a",
      worktree: { path: "/wt/b" },
      agent: "opencode",
      runner,
    });
    expect(remaining.length).toBe(0);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.message).toContain("terminal_handle_stale");
    expect(r.attempts.map((a) => a.receipt.dispatchId)).toEqual([
      FAILED_DISPATCH,
      "ctx_second",
    ]);
    expect(r.attempts.flatMap((a) => a.cleanup.closedTerminals)).toEqual([]);
    expect(r.attempts.flatMap((a) => a.cleanup.unclosedTerminals)).toEqual([
      { id: FAILED_TERMINAL, reason: "retained: retained" },
      { id: "term_second", reason: "retained: retained" },
    ]);
    expect(calls.some((c) => c[0] === "terminal")).toBe(false);
    expect(calls.filter((c) => c.includes("worker-start")).length).toBe(2);
    expect(flag(calls[2], "--worktree")).toBe("path:/wt/b");
  });

  it("retryOf: the first attempt carries --retry-of AND keeps --retry-request", async () => {
    const rid = "1112c03b-c129-4ba1-82eb-9578ed8cf571";
    const { runner, calls } = queue([
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: { path: "/wt/a" },
      agent: "opencode",
      retryOf: "ctx_old",
      requestId: rid,
      runner,
    });
    expect(r.status).toBe("started");
    expect(flag(calls[0], "--retry-of")).toBe("ctx_old");
    expect(flag(calls[0], "--retry-request")).toBe(rid);
  });

  it("retryOf + failed first attempt: the automatic retry retries the failed dispatch", async () => {
    const { runner, calls, remaining } = queue([
      [
        "orchestration worker-start",
        failedReceipt(FAILED_DISPATCH, FAILED_TERMINAL),
      ],
      ["orchestration worker-release", release(FAILED_DISPATCH, "released")],
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      retryOf: "ctx_old",
      requestId: "1112c03b-c129-4ba1-82eb-9578ed8cf571",
      runner,
    });
    expect(remaining.length).toBe(0);
    expect(r.status).toBe("started");
    expect(flag(calls[0], "--retry-of")).toBe("ctx_old");
    expect(flag(calls[2], "--retry-of")).toBe(FAILED_DISPATCH);
    expect(flag(calls[2], "--retry-request")).not.toBe(
      "1112c03b-c129-4ba1-82eb-9578ed8cf571",
    );
  });

  it("deliveryConfirmed is false when Orca cannot observe the turn (ready fixture)", async () => {
    const { runner } = queue([
      ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      preflight: false,
      runner,
    });
    expect(r.status).toBe("started");
    if (r.status === "started") expect(r.deliveryConfirmed).toBe(false);
  });

  it("deliveryConfirmed is false when only prompt.observation is unsupported", async () => {
    const doc = json("worker-start-ready.json");
    doc.result.turnStart = "confirmed";
    const { runner } = queue([["orchestration worker-start", envelope(doc)]]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      preflight: false,
      runner,
    });
    if (r.status !== "started") throw new Error(r.status);
    expect(r.deliveryConfirmed).toBe(false);
  });

  it("deliveryConfirmed is true when the turn start is confirmed", async () => {
    const doc = json("worker-start-ready.json");
    doc.result.turnStart = "confirmed";
    doc.result.prompt.observation = "observed";
    const { runner } = queue([["orchestration worker-start", envelope(doc)]]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      preflight: false,
      runner,
    });
    if (r.status !== "started") throw new Error(r.status);
    expect(r.deliveryConfirmed).toBe(true);
  });

  it("does not close terminals when release already closed them or is uncertain", async () => {
    for (const [state, closes] of [
      ["released", false],
      ["release_unknown", false],
      ["release_pending", false],
    ] as const) {
      const { runner, calls } = queue([
        [
          "orchestration worker-start",
          failedReceipt(FAILED_DISPATCH, FAILED_TERMINAL),
        ],
        [
          "orchestration worker-release",
          release(FAILED_DISPATCH, state, { recovery: "follow me" }),
        ],
        ["orchestration worker-start", out(fixture("worker-start-ready.json"))],
      ]);
      const r = await startTask({
        taskId: "t",
        worktree: "current",
        agent: "opencode",
        runner,
      });
      expect(calls.some((c) => c[0] === "terminal")).toBe(closes);
      expect(r.status).toBe("started");
      if (r.status === "started" && state !== "released") {
        expect(r.failedAttempts[0].cleanup.unclosedTerminals[0]).toMatchObject({
          id: FAILED_TERMINAL,
        });
        expect(r.failedAttempts[0].cleanup.recovery).toBe("follow me");
      }
    }
  });

  it("returns blocked with unmet dependencies on task_not_startable", async () => {
    const { runner, calls } = queue([
      [
        "orchestration worker-start",
        out(fixture("worker-start-not-startable.json"), 1),
      ],
    ]);
    const r = await startTask({
      taskId: "task_2f9e17ca318d",
      worktree: "current",
      agent: "opencode",
      runner,
    });
    expect(r).toMatchObject({
      status: "blocked",
      unmetDependencies: ["task_8b3fb8fed05a"],
    });
    expect(calls.length).toBe(1);
  });

  it("returns outcome_unknown untouched — no retry, no release", async () => {
    const doc = json("worker-start-failed.json");
    doc.result.state = "outcome_unknown";
    const { runner, calls } = queue([
      ["orchestration worker-start", envelope(doc, 1)],
    ]);
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      runner,
    });
    expect(r.status).toBe("outcome_unknown");
    if (r.status === "outcome_unknown")
      expect(r.receipt.dispatchId).toBe(FAILED_DISPATCH);
    expect(calls.length).toBe(1);
  });

  it("returns a transport error with the request id so the start can be replayed", async () => {
    const runner: OrcaRunner = async () => {
      throw new Error("spawn orca ENOENT");
    };
    const r = await startTask({
      taskId: "t",
      worktree: "current",
      agent: "opencode",
      runner,
      requestId: "1112c03b-c129-4ba1-82eb-9578ed8cf571",
    });
    expect(r.status).toBe("error");
    if (r.status === "error")
      expect(r.requestId).toBe("1112c03b-c129-4ba1-82eb-9578ed8cf571");
  });
});
