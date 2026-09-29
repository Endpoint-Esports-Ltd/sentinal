/**
 * `orca_wait` / `orca_ack` / `orca_stop` / `orca_release` /
 * `orca_remove_worktree`. Fake runner only — never the real `orca`.
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

const RUN = "run_93672f816e9f";
const DONE = "ctx_4c968df3149b";
const STALLED = "ctx_f359d5e49a0b";

/** One settled worker_done, one worker whose agent exited. */
function settleRoutes(extra: Array<[string, Reply]> = []) {
  return fakeOrca([
    ...extra,
    ["orchestration check", out(fixture("check-worker-done.json"))],
    [
      "orchestration worker-list",
      ok({
        workers: [
          {
            dispatchId: DONE,
            projection: {
              outcome: "in_progress",
              liveness: { verdict: "live" },
            },
          },
          {
            dispatchId: STALLED,
            projection: {
              outcome: "in_progress",
              liveness: { verdict: "exited", reason: "process gone" },
            },
          },
        ],
      }),
    ],
    ["orchestration worker-read", out(fixture("worker-read-auth-stall.json"))],
    [
      "orchestration worker-stop",
      (args) => ok({ dispatchId: flag(args, "--dispatch"), state: "stopped" }),
    ],
    [
      "orchestration worker-release",
      (args) => ok({ dispatchId: flag(args, "--dispatch"), state: "released" }),
    ],
    ["orchestration check", ok({ runId: RUN, deliveryId: null, messages: [] })],
    ["worktree rm", ok({ removed: true })],
  ]);
}

describe("orca_wait", () => {
  it("returns worker_done payloads and stall verdicts with evidence ids, without acking", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.delivery_id).toBe("delivery_aa54dfdecfad");
    expect(r.data.worker_done).toEqual([
      expect.objectContaining({
        task_id: "task_8b3fb8fed05a",
        dispatch_id: DONE,
        outcome: "succeeded",
        files_modified: ["spike/worker-a.txt"],
      }),
    ]);
    expect(r.data.stalls).toEqual([
      expect.objectContaining({ dispatch_id: STALLED, reason: "exited" }),
    ]);
    expect(r.data.stalls[0].evidence_id).toMatch(/^ev_/);
    const check = f.called("orchestration check")[0]!;
    expect(check).not.toContain("--ack");
    expect(flag(check, "--timeout-ms")).toBe("35000");
    // the settled dispatch is not read for stalls
    expect(
      f.called("orchestration worker-read").map((c) => flag(c, "--dispatch")),
    ).toEqual([STALLED]);
    expect(r.text).toContain("orca_ack");
  });

  it("marks a worker_done for a dispatch already released in this session as replayed (un-acked delivery re-sent)", async () => {
    const f = settleRoutes([
      [
        "orchestration worker-release",
        ok({ dispatchId: DONE, state: "released" }),
      ],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    const first = await call("orca_wait", { run_id: RUN });
    expect(first.data.worker_done[0].replayed).toBe(false);
    await call("orca_release", { dispatch_id: DONE });
    const again = await call("orca_wait", { run_id: RUN });
    expect(again.data.worker_done[0].replayed).toBe(true);
    expect(again.text).toContain("already settled");
  });

  it("clamps timeout_ms to 40000", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    await call("orca_wait", { run_id: RUN, timeout_ms: 90_000 });
    expect(flag(f.called("orchestration check")[0]!, "--timeout-ms")).toBe(
      "40000",
    );
  });

  it("treats an NDJSON timeout as a checkpoint", async () => {
    const f = fakeOrca([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      ["orchestration worker-list", ok({ workers: [] })],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.timed_out).toBe(true);
    expect(r.data.stalls).toEqual([]);
    expect(r.text).toContain("orca_wait again");
  });
});

/** A dispatch whose brief never reached OpenCode (issue #12), and a settled one. */
const HOME = "ctx_c8a313c725e8";
const RECLAIM = "ctx_b72731025b9f";
const HOME_DISPATCHED = Date.parse("2026-09-29T21:46:28Z");

function neverStartedRoutes() {
  return fakeOrca([
    [
      "orchestration check",
      ok({ runId: RUN, deliveryId: null, messages: [], timedOut: true }),
    ],
    [
      "orchestration worker-list",
      ok({
        workers: [
          {
            dispatchId: HOME,
            taskId: "task_home",
            projection: {
              outcome: "in_progress",
              liveness: { verdict: "live" },
            },
          },
          {
            dispatchId: RECLAIM,
            taskId: "task_done",
            terminalState: "reclaimable",
            agentTerminalHandle: "term_done",
            projection: { outcome: "succeeded", liveness: { verdict: "live" } },
          },
        ],
      }),
    ],
    [
      "orchestration worker-read",
      out(fixture("worker-read-terminal-home.json")),
    ],
    ["orchestration worker-show", out(fixture("worker-show-dispatched.json"))],
    [
      "orchestration worker-stop",
      (args) => ok({ dispatchId: flag(args, "--dispatch"), state: "stopped" }),
    ],
    [
      "orchestration worker-release",
      (args) =>
        ok({
          dispatchId: flag(args, "--dispatch"),
          state: "retained",
          reason: "external_terminal",
        }),
    ],
  ]);
}

describe("orca_wait — never-started and reclaimable (issue #12)", () => {
  it("reports a never-started stall whose Next hint is stop then orca_start retry_of", async () => {
    const f = neverStartedRoutes();
    const call = capture({
      runner: f.runner,
      env: {},
      now: () => HOME_DISPATCHED + 4 * 60_000,
    });
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.stalls).toEqual([
      expect.objectContaining({ dispatch_id: HOME, reason: "never-started" }),
    ]);
    expect(r.text).toContain("retry_of");
    expect(r.text).toContain("dispatch-show --preamble");
    expect(r.text).not.toMatch(/dcap_(?!REDACTED)/);
  });

  it("names orca_start retry_of after stopping a never-started worker", async () => {
    const f = neverStartedRoutes();
    const call = capture({
      runner: f.runner,
      env: {},
      now: () => HOME_DISPATCHED + 4 * 60_000,
    });
    const w = await call("orca_wait", { run_id: RUN });
    const stop = await call("orca_stop", {
      dispatch_id: HOME,
      evidence_id: w.data.stalls[0].evidence_id,
    });
    expect(stop.data.ok).toBe(true);
    expect(stop.text).toContain(`retry_of: "${HOME}"`);
    expect(stop.text).toContain("task_home");
  });

  it("lists reclaimable terminals until this session released them (any answer, retained included)", async () => {
    const f = neverStartedRoutes();
    const call = capture({
      runner: f.runner,
      env: {},
      now: () => HOME_DISPATCHED + 60_000,
    });
    const first = await call("orca_wait", { run_id: RUN });
    expect(first.data.reclaimable).toEqual([
      expect.objectContaining({ dispatch_id: RECLAIM, task_id: "task_done" }),
    ]);
    expect(first.text).toContain("reclaimable");
    expect(first.text).toContain(RECLAIM);
    await call("orca_release", { dispatch_id: RECLAIM });
    const again = await call("orca_wait", { run_id: RUN });
    expect(again.data.reclaimable).toEqual([]);
  });

  it("says reclaimable is UNKNOWN (not empty) when the stall check failed", async () => {
    const f = fakeOrca([
      [
        "orchestration check",
        ok({ runId: RUN, deliveryId: null, messages: [], timedOut: true }),
      ],
      [
        "orchestration worker-list",
        out(
          JSON.stringify({
            id: "x",
            ok: false,
            error: { code: "runtime_error", message: "boom" },
          }),
          1,
        ),
      ],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_wait", { run_id: RUN });
    expect(r.data.reclaimable_unknown).toBe(true);
    expect(r.text).toContain("reclaimable terminals unknown");
  });

  it("describes the never-started stall kind in the tool description", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const descs = new Map<string, string>();
    server.tool = ((...a: unknown[]) => {
      descs.set(a[0] as string, a[1] as string);
    }) as typeof server.tool;
    registerOrcaTools(server, { env: {} });
    expect(descs.get("orca_wait")).toContain("never reached the agent");
    expect(descs.get("orca_wait")).toContain("reclaimable");
  });
});

describe("orca_stop", () => {
  it("refuses without a verdict from orca_wait", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_stop", {
      dispatch_id: STALLED,
      evidence_id: "ev_made_up",
    });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe("stop_refused");
    expect(f.called("orchestration worker-stop")).toEqual([]);
  });

  it("refuses a wrong evidence id and a dispatch that did not stall", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const w = await call("orca_wait", { run_id: RUN });
    const bad = await call("orca_stop", {
      dispatch_id: STALLED,
      evidence_id: "ev_wrong",
    });
    expect(bad.data.ok).toBe(false);
    const other = await call("orca_stop", {
      dispatch_id: DONE,
      evidence_id: w.data.stalls[0].evidence_id,
    });
    expect(other.data.ok).toBe(false);
    expect(f.called("orchestration worker-stop")).toEqual([]);
  });

  it("stops with the latest verdict's evidence, once", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const w = await call("orca_wait", { run_id: RUN });
    const ev = w.data.stalls[0].evidence_id;
    const r = await call("orca_stop", {
      dispatch_id: STALLED,
      evidence_id: ev,
    });
    expect(r.data.ok).toBe(true);
    expect(r.data.state).toBe("stopped");
    const stops = f.called("orchestration worker-stop");
    expect(stops.length).toBe(1);
    expect(flag(stops[0]!, "--dispatch")).toBe(STALLED);
    const again = await call("orca_stop", {
      dispatch_id: STALLED,
      evidence_id: ev,
    });
    expect(again.data.ok).toBe(false);
    expect(f.called("orchestration worker-stop").length).toBe(1);
  });

  it("drops a verdict the next orca_wait no longer reports", async () => {
    let wait = 0;
    const f = fakeOrca([
      ["orchestration check", out(fixture("check-wait-timeout.ndjson"))],
      [
        "orchestration worker-list",
        () => {
          wait += 1;
          return ok({
            workers:
              wait === 1
                ? [
                    {
                      dispatchId: STALLED,
                      projection: {
                        outcome: "in_progress",
                        liveness: { verdict: "exited" },
                      },
                    },
                  ]
                : [],
          });
        },
      ],
      ["orchestration worker-read", ok({ dispatchId: STALLED })],
      ["orchestration worker-stop", ok({ state: "stopped" })],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    const w1 = await call("orca_wait", { run_id: RUN });
    const ev = w1.data.stalls[0].evidence_id;
    await call("orca_wait", { run_id: RUN });
    const r = await call("orca_stop", {
      dispatch_id: STALLED,
      evidence_id: ev,
    });
    expect(r.data.ok).toBe(false);
    expect(f.called("orchestration worker-stop")).toEqual([]);
  });
});

describe("orca_ack", () => {
  it("acks with the run remembered from orca_wait", async () => {
    const f = fakeOrca([
      [
        "orchestration check --run run_93672f816e9f --ack",
        ok({ runId: RUN, deliveryId: null, messages: [] }),
      ],
      ["orchestration check", out(fixture("check-worker-done.json"))],
      ["orchestration worker-list", ok({ workers: [] })],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    await call("orca_wait", { run_id: RUN });
    const r = await call("orca_ack", { delivery_id: "delivery_aa54dfdecfad" });
    expect(r.data.ok).toBe(true);
    const ack = f.calls.find((c) => c.includes("--ack"))!;
    expect(flag(ack, "--ack")).toBe("delivery_aa54dfdecfad");
    expect(flag(ack, "--run")).toBe(RUN);
    expect(ack).toContain("--retry-request");
  });

  it("refuses an unknown delivery without a run_id", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_ack", { delivery_id: "delivery_x" });
    expect(r.data.ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
});

describe("orca_release / orca_remove_worktree", () => {
  it("releases a dispatch", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_release", { dispatch_id: DONE });
    expect(r.data).toMatchObject({ ok: true, state: "released" });
    expect(
      flag(f.called("orchestration worker-release")[0]!, "--dispatch"),
    ).toBe(DONE);
  });

  it("surfaces release_unknown as an error with Orca's recovery", async () => {
    const f = fakeOrca([
      [
        "orchestration worker-release",
        ok({ dispatchId: DONE, state: "release_unknown", recovery: "run X" }),
      ],
    ]);
    const call = capture({ runner: f.runner, env: {} });
    const r = await call("orca_release", { dispatch_id: DONE });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.message).toContain("run X");
  });

  it("removes an absolute worktree path and refuses a relative one", async () => {
    const f = settleRoutes();
    const call = capture({ runner: f.runner, env: {} });
    const bad = await call("orca_remove_worktree", { path: "wt/a" });
    expect(bad.data.ok).toBe(false);
    expect(f.called("worktree rm")).toEqual([]);
    const r = await call("orca_remove_worktree", { path: "/wt/a" });
    expect(r.data.ok).toBe(true);
    const rm = f.called("worktree rm")[0]!;
    expect(flag(rm, "--worktree")).toBe("path:/wt/a");
    expect(rm).not.toContain("--force");
  });

  it("refuses a path the injected guard rejects (main checkout, coordinator's checkout, live Sentinal row)", async () => {
    const f = settleRoutes();
    const seen: string[] = [];
    const call = capture({
      runner: f.runner,
      env: {},
      guardWorktreeRemoval: async (p) => {
        seen.push(p);
        return p === "/repo/main"
          ? { ok: false, reason: "it is the main checkout" }
          : { ok: true };
      },
    });
    const bad = await call("orca_remove_worktree", { path: "/repo/main" });
    expect(bad.data.ok).toBe(false);
    expect(bad.data.error.code).toBe("removal_refused");
    expect(bad.data.error.message).toContain("main checkout");
    expect(f.called("worktree rm")).toEqual([]);
    const good = await call("orca_remove_worktree", { path: "/repo/child" });
    expect(good.data.ok).toBe(true);
    expect(seen).toEqual(["/repo/main", "/repo/child"]);
  });
});
