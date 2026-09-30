import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import {
  collectStalls,
  stallVerdict,
  DEFAULT_MAX_IDLE_MS,
  DEFAULT_NEVER_STARTED_MS,
} from "./stall.js";
import type {
  OrcaTranscriptMessage,
  OrcaWorkerListRow,
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

/** The spike's real 401 transcript (S4). */
const authRead = (): OrcaWorkerReadResult =>
  JSON.parse(fixture("worker-read-auth-stall.json")).result;
const AUTH_TS = 1790618364142;

/**
 * A `worker-list` row. The field names come from Orca 1.4.215's CLI formatter
 * (`handlers/orchestration/worker-terminal-handlers.js`) — synthesized, not
 * recorded from a live run.
 */
function row(
  dispatchId: string,
  verdict: string | undefined,
  extra: Partial<OrcaWorkerListRow> = {},
): OrcaWorkerListRow {
  return {
    dispatchId,
    taskId: `task_${dispatchId}`,
    workerState: "ready",
    dispatchStatus: "dispatched",
    terminalState: "active",
    projection: {
      dispatchId,
      outcome: "in_progress",
      ...(verdict ? { liveness: { verdict } } : {}),
    },
    ...extra,
  };
}

function transcript(
  msgs: Array<
    Pick<OrcaTranscriptMessage, "role" | "timestamp"> & { text: string }
  >,
): OrcaWorkerReadResult {
  return {
    dispatchId: "ctx_x",
    source: "transcript",
    transcript: {
      messages: msgs.map((m, i) => ({
        id: `m${i}`,
        role: m.role,
        timestamp: m.timestamp,
        blocks: [{ type: "text", text: m.text }],
      })),
    },
  };
}

const MIN = 60_000;

describe("stallVerdict", () => {
  it("stalls on the spike's 401 transcript while the agent reads live", () => {
    const v = stallVerdict({
      workerListRow: row("ctx_f359d5e49a0b", "live"),
      transcript: authRead(),
      now: AUTH_TS + 5_000,
    });
    expect(v.stalled).toBe(true);
    expect(v.reason).toBe("auth-error");
    expect(v.dispatchId).toBe("ctx_f359d5e49a0b");
    expect(v.evidence).toContain("401");
  });

  it("stalls on exited liveness without needing a transcript", () => {
    const v = stallVerdict({
      workerListRow: row("ctx_a", "exited"),
      transcript: null,
      now: Date.now(),
    });
    expect(v).toMatchObject({ stalled: true, reason: "exited" });
  });

  it("never stalls on unverifiable or missing liveness, even with a 401 transcript", () => {
    const noProjection = { ...authRead(), projection: undefined };
    for (const r of [
      row("ctx_a", "unverifiable"),
      row("ctx_a", undefined),
      null,
    ]) {
      const v = stallVerdict({
        workerListRow: r,
        transcript: r ? authRead() : noProjection,
        now: AUTH_TS + 60 * MIN,
      });
      expect(v.stalled).toBe(false);
      expect(v.reason).toBeNull();
    }
  });

  it("stalls when the last assistant turn is older than maxIdleMs", () => {
    const now = 10_000_000_000;
    const t = transcript([
      { role: "user", timestamp: now - 30 * MIN, text: "do the task" },
      { role: "assistant", timestamp: now - 11 * MIN, text: "All done." },
    ]);
    const v = stallVerdict({
      workerListRow: row("ctx_a", "live"),
      transcript: t,
      now,
    });
    expect(v).toMatchObject({ stalled: true, reason: "idle-no-report" });
    expect(DEFAULT_MAX_IDLE_MS).toBe(10 * MIN);
  });

  it("does not stall a recent assistant turn, or when maxIdleMs is larger", () => {
    const now = 10_000_000_000;
    const t = transcript([
      { role: "assistant", timestamp: now - 9 * MIN, text: "Working on it" },
    ]);
    expect(
      stallVerdict({ workerListRow: row("ctx_a", "live"), transcript: t, now })
        .stalled,
    ).toBe(false);
    const old = transcript([
      { role: "assistant", timestamp: now - 11 * MIN, text: "Working" },
    ]);
    expect(
      stallVerdict({
        workerListRow: row("ctx_a", "live"),
        transcript: old,
        now,
        maxIdleMs: 20 * MIN,
      }).stalled,
    ).toBe(false);
  });

  it("does not stall once worker_done was sent", () => {
    const v = stallVerdict({
      workerListRow: row("ctx_f359d5e49a0b", "live"),
      transcript: authRead(),
      now: AUTH_TS + 60 * MIN,
      workerDoneSent: true,
    });
    expect(v.stalled).toBe(false);
  });

  it("does not stall when a user turn follows the last assistant turn", () => {
    const now = 10_000_000_000;
    const t = transcript([
      {
        role: "assistant",
        timestamp: now - 40 * MIN,
        text: "Please run /login",
      },
      { role: "user", timestamp: now - 30 * MIN, text: "retry now" },
    ]);
    expect(
      stallVerdict({ workerListRow: row("ctx_a", "live"), transcript: t, now })
        .stalled,
    ).toBe(false);
  });

  it("recognises each auth pattern but not an unrelated 401", () => {
    const now = 10_000_000_000;
    const verdictFor = (text: string) =>
      stallVerdict({
        workerListRow: row("ctx_a", "live"),
        transcript: transcript([
          { role: "assistant", timestamp: now - 1_000, text },
        ]),
        now,
      });
    for (const text of [
      "Please run /login",
      "OAuth access token is invalid",
      "Error: not logged in",
      "API Error: 401 Unauthorized",
      "HTTP 401 unauthorized",
    ]) {
      expect(verdictFor(text).reason).toBe("auth-error");
    }
    expect(verdictFor("Fixed 401 tests across the suite").stalled).toBe(false);
  });

  it("does not stall on a live worker with no transcript", () => {
    const v = stallVerdict({
      workerListRow: row("ctx_a", "live"),
      transcript: null,
      now: Date.now(),
    });
    expect(v.stalled).toBe(false);
  });
});

function scripted(handlers: Array<[string, OrcaRunOutput]>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const hit = handlers.find(
      ([k]) => key === k || args.join(" ").startsWith(k),
    );
    if (!hit) throw new Error(`unexpected orca call: ${args.join(" ")}`);
    return hit[1];
  };
  return { runner, calls };
}

const ok = (result: unknown): OrcaRunOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: "x", ok: true, result }),
  stderr: "",
});

describe("collectStalls", () => {
  it("reads only still-active dispatches and reports the auth stall", async () => {
    const workers = [
      row("ctx_f359d5e49a0b", "live"),
      row("ctx_done", "live", {
        workerState: "completed",
        dispatchStatus: "completed",
        projection: { outcome: "succeeded", liveness: { verdict: "live" } },
      }),
      row("ctx_unv", "unverifiable"),
    ];
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers })],
      [
        "orchestration worker-read --dispatch ctx_f359d5e49a0b",
        {
          exitCode: 0,
          stdout: fixture("worker-read-auth-stall.json"),
          stderr: "",
        },
      ],
      [
        "orchestration worker-read --dispatch ctx_unv",
        ok(
          transcript([
            { role: "assistant", timestamp: 1, text: "401 Please run /login" },
          ]),
        ),
      ],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: AUTH_TS + 5_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stalls.map((s) => s.dispatchId)).toEqual(["ctx_f359d5e49a0b"]);
    expect(r.verdicts.map((v) => v.dispatchId).sort()).toEqual([
      "ctx_f359d5e49a0b",
      "ctx_unv",
    ]);
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-list",
      "--run",
      "run_1",
      "--json",
    ]);
    expect(calls.some((c) => c.includes("ctx_done"))).toBe(false);
    const read = calls.find((c) => c.includes("ctx_f359d5e49a0b"))!;
    expect(read).toEqual([
      "orchestration",
      "worker-read",
      "--dispatch",
      "ctx_f359d5e49a0b",
      "--source",
      "auto",
      "--limit",
      "20",
      "--json",
    ]);
  });

  it("skips dispatches that already reported worker_done", async () => {
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers: [row("ctx_a", "exited")] })],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: Date.now(),
      settledDispatchIds: ["ctx_a"],
    });
    expect(r.ok && r.stalls).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("treats a failed worker-read as absence (no stall unless exited)", async () => {
    const { runner } = scripted([
      [
        "orchestration worker-list",
        ok({ workers: [row("ctx_live", "live"), row("ctx_gone", "exited")] }),
      ],
      [
        "orchestration worker-read",
        {
          exitCode: 1,
          stdout: fixture("worker-show-not-found.json"),
          stderr: "",
        },
      ],
    ]);
    const r = await collectStalls({ runId: "run_1", runner, now: Date.now() });
    expect(r.ok && r.stalls.map((s) => s.dispatchId)).toEqual(["ctx_gone"]);
  });

  it("stays within a shared deadline: every call gets only the time left, and reads stop when it runs out", async () => {
    const seen: Array<{ args: string[]; timeoutMs?: number }> = [];
    let clock = 0;
    const workers = [
      row("ctx_1", "live"),
      row("ctx_2", "live"),
      row("ctx_3", "live"),
    ];
    const runner = async (args: string[], opts?: { timeoutMs?: number }) => {
      seen.push({ args, timeoutMs: opts?.timeoutMs });
      clock += 4_000; // every call takes 4 s
      return args[1] === "worker-list"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, result: { workers } }),
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              result: { transcript: { messages: [] } },
            }),
            stderr: "",
          };
    };
    const r = await collectStalls({
      runId: "run_1",
      runner,
      budgetMs: 10_000,
      clock: () => clock,
    });
    expect(r.ok).toBe(true);
    // list (4 s) + read 1 (8 s) + read 2 (12 s ≥ 10 s budget) → read 3 skipped
    expect(seen.map((c) => c.args[1])).toEqual([
      "worker-list",
      "worker-read",
      "worker-read",
    ]);
    for (const c of seen) expect(c.timeoutMs!).toBeLessThanOrEqual(10_000);
    expect(seen[1]!.timeoutMs!).toBeLessThanOrEqual(6_000);
  });

  it("returns the worker-list error instead of guessing", async () => {
    const { runner } = scripted([
      [
        "orchestration worker-list",
        { exitCode: 1, stdout: fixture("unknown-command.json"), stderr: "" },
      ],
    ]);
    const r = await collectStalls({ runId: "run_1", runner, now: Date.now() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_argument");
  });
});

// ------------------------------------------------ terminal-tail verdicts (#12)

const HOME_ID = "ctx_c8a313c725e8";
const homeRead = (): OrcaWorkerReadResult =>
  JSON.parse(fixture("worker-read-terminal-home.json")).result;
const startedRead = (): OrcaWorkerReadResult =>
  JSON.parse(fixture("worker-read-terminal-started.json")).result;
const showDispatched = (): OrcaWorkerShowResult =>
  JSON.parse(fixture("worker-show-dispatched.json")).result;
/** `dispatchedAt` "2026-09-29 21:46:28" is UTC without a zone. */
const DISPATCHED = Date.parse("2026-09-29T21:46:28Z");

describe("stallVerdict — terminal tail", () => {
  const home = (extra: Partial<Parameters<typeof stallVerdict>[0]> = {}) =>
    stallVerdict({
      workerListRow: row(HOME_ID, "live"),
      transcript: homeRead(),
      show: showDispatched(),
      now: DISPATCHED + 4 * MIN,
      ...extra,
    });

  it("stalls a worker whose home screen is still visible 4 min after dispatch", () => {
    const v = home();
    expect(v).toMatchObject({
      dispatchId: HOME_ID,
      stalled: true,
      reason: "never-started",
    });
    expect(v.evidence).toContain("240 s");
    expect(v.evidence).toContain("no heartbeat");
    expect(v.evidence).toContain("home screen visible");
    expect(v.evidence).toContain("dispatch id never shown");
    expect(v.taskId).toBe(`task_${HOME_ID}`);
    expect(DEFAULT_NEVER_STARTED_MS).toBe(3 * MIN);
  });

  it("does not stall at 2 min, or when neverStartedMs is larger", () => {
    expect(home({ now: DISPATCHED + 2 * MIN }).stalled).toBe(false);
    expect(home({ neverStartedMs: 5 * MIN }).stalled).toBe(false);
  });

  it("does not stall once a heartbeat was recorded", () => {
    const show = showDispatched();
    show.dispatch.lastHeartbeatAt = "2026-09-29 21:47:00";
    const v = home({ show });
    expect(v.stalled).toBe(false);
    expect(v.evidence).toContain("heartbeat");
  });

  it("does not stall when the dispatch id is in the tail", () => {
    const read = homeRead();
    read.terminal!.tail = [
      ...read.terminal!.tail!,
      `  ┃  dispatch ${HOME_ID.slice(0, 8)}`,
      `  ┃  ${HOME_ID.slice(8)}`,
    ];
    const v = home({ transcript: read });
    expect(v.stalled).toBe(false);
    expect(v.evidence).toContain("dispatch id");
  });

  it("does not stall when the dispatch id is unknown (the tail check cannot run)", () => {
    const read = {
      ...homeRead(),
      dispatchId: undefined,
    } as unknown as OrcaWorkerReadResult;
    const v = home({ workerListRow: null, transcript: read });
    expect(v.dispatchId).toBeNull();
    expect(v.stalled).toBe(false);
    expect(v.evidence).toContain("dispatch id unknown");
  });

  it("does not stall the started fixture, which has no home screen", () => {
    const v = home({ transcript: startedRead() });
    expect(v.stalled).toBe(false);
  });

  it("never stalls on unverifiable liveness", () => {
    const read = { ...homeRead(), projection: undefined };
    const v = home({
      workerListRow: row(HOME_ID, "unverifiable"),
      transcript: read,
    });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("has no verdict without worker-show, or with an unparsable dispatchedAt", () => {
    expect(home({ show: null }).stalled).toBe(false);
    expect(home({ show: undefined }).stalled).toBe(false);
    const bad = showDispatched();
    bad.dispatch.dispatchedAt = "not a date";
    expect(home({ show: bad }).stalled).toBe(false);
    const none = showDispatched();
    delete none.dispatch.dispatchedAt;
    expect(home({ show: none }).stalled).toBe(false);
  });

  it("accepts a dispatchedAt that already carries a zone", () => {
    const show = showDispatched();
    show.dispatch.dispatchedAt = "2026-09-29T21:46:28Z";
    expect(home({ show }).reason).toBe("never-started");
  });

  it("stalls on an auth error in the tail, redacting capabilities", () => {
    const read = homeRead();
    read.terminal!.tail = [
      "  $ orca … --dispatch-capability dcap_SECRET123",
      "  API Error: 401 Please run /login dcap_SECRET123",
    ];
    const v = home({ transcript: read, show: null, now: DISPATCHED });
    expect(v).toMatchObject({ stalled: true, reason: "auth-error" });
    expect(v.evidence).toContain("401");
    expect(v.evidence).not.toContain("dcap_SECRET123");
  });

  it("keeps the transcript path first when a transcript is present", () => {
    const v = stallVerdict({
      workerListRow: row("ctx_f359d5e49a0b", "live"),
      transcript: authRead(),
      show: showDispatched(),
      now: AUTH_TS + 5_000,
    });
    expect(v.reason).toBe("auth-error");
  });
});

describe("collectStalls — never-started", () => {
  const readOut = (name: string): OrcaRunOutput => ({
    exitCode: 0,
    stdout: fixture(name),
    stderr: "",
  });

  it("confirms a home-screen suspect with worker-show and reports never-started", async () => {
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers: [row(HOME_ID, "live")] })],
      ["orchestration worker-read", readOut("worker-read-terminal-home.json")],
      ["orchestration worker-show", readOut("worker-show-dispatched.json")],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: DISPATCHED + 4 * MIN,
    });
    expect(r.ok && r.stalls.map((s) => [s.dispatchId, s.reason])).toEqual([
      [HOME_ID, "never-started"],
    ]);
    expect(calls.at(-1)).toEqual([
      "orchestration",
      "worker-show",
      "--dispatch",
      HOME_ID,
      "--json",
    ]);
  });

  it("passes neverStartedMs through", async () => {
    const { runner } = scripted([
      ["orchestration worker-list", ok({ workers: [row(HOME_ID, "live")] })],
      ["orchestration worker-read", readOut("worker-read-terminal-home.json")],
      ["orchestration worker-show", readOut("worker-show-dispatched.json")],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: DISPATCHED + 4 * MIN,
      neverStartedMs: 10 * MIN,
    });
    expect(r.ok && r.stalls).toEqual([]);
  });

  it("never calls worker-show for a started worker", async () => {
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers: [row(HOME_ID, "live")] })],
      [
        "orchestration worker-read",
        readOut("worker-read-terminal-started.json"),
      ],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: DISPATCHED + 60 * MIN,
    });
    expect(r.ok && r.stalls).toEqual([]);
    expect(calls.some((c) => c[1] === "worker-show")).toBe(false);
  });

  it("treats a failed worker-show as absence", async () => {
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers: [row(HOME_ID, "live")] })],
      ["orchestration worker-read", readOut("worker-read-terminal-home.json")],
      [
        "orchestration worker-show",
        {
          exitCode: 1,
          stdout: fixture("worker-show-not-found.json"),
          stderr: "",
        },
      ],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: DISPATCHED + 60 * MIN,
    });
    expect(r.ok && r.stalls).toEqual([]);
    expect(r.ok && r.verdicts.length).toBe(1);
    expect(calls.some((c) => c[1] === "worker-show")).toBe(true);
  });

  it("lists reclaimable terminals, settled rows included, from the one worker-list call", async () => {
    const workers = [
      row("ctx_done", undefined, {
        workerState: "completed",
        dispatchStatus: "completed",
        terminalState: "reclaimable",
        agentTerminalHandle: "term_done",
        projection: { outcome: "succeeded" },
      }),
      row("ctx_active", "unverifiable"),
    ];
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers })],
      ["orchestration worker-read", ok({ transcript: { messages: [] } })],
    ]);
    const r = await collectStalls({
      runId: "run_1",
      runner,
      now: Date.now(),
      settledDispatchIds: ["ctx_done"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reclaimable).toEqual([
      {
        dispatchId: "ctx_done",
        taskId: "task_ctx_done",
        terminal: "term_done",
      },
    ]);
    expect(calls.filter((c) => c[1] === "worker-list").length).toBe(1);
  });

  it("reports reclaimable even when the reads run out of budget", async () => {
    let clock = 0;
    const workers = [row("ctx_r", "live", { terminalState: "reclaimable" })];
    const runner: OrcaRunner = async (args) => {
      clock += 20_000;
      if (args[1] !== "worker-list") throw new Error("no reads expected");
      return ok({ workers });
    };
    const r = await collectStalls({
      runId: "run_1",
      runner,
      budgetMs: 10_000,
      clock: () => clock,
    });
    expect(r.ok && r.reclaimable).toEqual([
      { dispatchId: "ctx_r", taskId: "task_ctx_r" },
    ]);
  });
});

describe("collectStalls — unverifiable liveness (1.4.209, issue #12 follow-up)", () => {
  const D209 = "ctx_d209000000a1";
  const AT209 = Date.parse("2026-09-29T23:11:43Z");
  const out = (name: string): OrcaRunOutput => ({
    exitCode: 0,
    stdout: fixture(name),
    stderr: "",
  });
  const gapRow = (
    reason = "missing_status",
    categories = ["unverifiable"],
  ): OrcaWorkerListRow =>
    row(D209, undefined, {
      taskId: "task_d209000000a1",
      projection: {
        dispatchId: D209,
        outcome: "in_progress",
        liveness: { verdict: "unverifiable", reason },
        attention: { categories, requiresAction: true },
      },
    });
  const showVerdict = (verdict: string): OrcaRunOutput => {
    const s = JSON.parse(fixture("worker-show-unverifiable-209.json"));
    s.result.projection.liveness = { verdict };
    return { exitCode: 0, stdout: JSON.stringify(s), stderr: "" };
  };

  it("reports the real dropped prompt as a never-started-unverifiable attention entry, never a stall", async () => {
    const { runner } = scripted([
      ["orchestration worker-list", ok({ workers: [gapRow()] })],
      [
        "orchestration worker-read",
        out("worker-read-terminal-home-unverifiable.json"),
      ],
      ["orchestration worker-show", out("worker-show-unverifiable-209.json")],
    ]);
    const r = await collectStalls({ runId: "r", runner, now: AT209 + 4 * MIN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stalls).toEqual([]);
    expect(r.attention).toEqual([
      expect.objectContaining({
        kind: "never-started-unverifiable",
        dispatchId: D209,
        taskId: "task_d209000000a1",
      }),
    ]);
  });

  it("lets worker-show's live verdict enable the normal never-started stall", async () => {
    const { runner } = scripted([
      ["orchestration worker-list", ok({ workers: [gapRow()] })],
      [
        "orchestration worker-read",
        out("worker-read-terminal-home-unverifiable.json"),
      ],
      ["orchestration worker-show", showVerdict("live")],
    ]);
    const r = await collectStalls({ runId: "r", runner, now: AT209 + 4 * MIN });
    expect(r.ok && r.stalls.map((s) => s.reason)).toEqual(["never-started"]);
    expect(r.ok && r.attention).toEqual([]);
  });

  it("turns worker-show's exited verdict into an exited stall", async () => {
    const { runner } = scripted([
      ["orchestration worker-list", ok({ workers: [gapRow()] })],
      ["orchestration worker-read", out("worker-read-terminal-started.json")],
      ["orchestration worker-show", showVerdict("exited")],
    ]);
    const r = await collectStalls({ runId: "r", runner, now: AT209 + 4 * MIN });
    expect(r.ok && r.stalls.map((s) => s.reason)).toEqual(["exited"]);
  });

  it("host_unavailable: no stall and no never-started entry, even if worker-show says exited", async () => {
    const { runner } = scripted([
      [
        "orchestration worker-list",
        ok({ workers: [gapRow("host_unavailable")] }),
      ],
      [
        "orchestration worker-read",
        out("worker-read-terminal-home-unverifiable.json"),
      ],
      ["orchestration worker-show", showVerdict("exited")],
    ]);
    const r = await collectStalls({ runId: "r", runner, now: AT209 + 4 * MIN });
    expect(r.ok && r.stalls).toEqual([]);
    expect(r.ok && r.attention.map((a) => a.kind)).not.toContain(
      "never-started-unverifiable",
    );
  });

  it("a healthy gap-unverifiable worker gets no stall and no attention (no spam)", async () => {
    const { runner, calls } = scripted([
      ["orchestration worker-list", ok({ workers: [gapRow()] })],
      ["orchestration worker-read", out("worker-read-terminal-started.json")],
      ["orchestration worker-show", out("worker-show-unverifiable-209.json")],
    ]);
    const r = await collectStalls({
      runId: "r",
      runner,
      now: AT209 + 60 * MIN,
    });
    expect(r.ok && r.stalls).toEqual([]);
    expect(r.ok && r.attention).toEqual([]);
    // worker-show IS consulted for a gap row (option 1)
    expect(calls.some((c) => c[1] === "worker-show")).toBe(true);
  });

  it("surfaces other requiresAction rows with Orca's next action", async () => {
    const r0 = gapRow("missing_status", ["failure"]);
    r0.projection = {
      ...r0.projection,
      liveness: { verdict: "live" },
      nextAction: { kind: "inspect", argv: ["orchestration", "worker-show"] },
    };
    const { runner } = scripted([
      ["orchestration worker-list", ok({ workers: [r0] })],
      ["orchestration worker-read", out("worker-read-terminal-started.json")],
    ]);
    const r = await collectStalls({ runId: "r", runner, now: AT209 + MIN });
    expect(r.ok && r.attention).toEqual([
      {
        kind: "orca-attention",
        dispatchId: D209,
        taskId: "task_d209000000a1",
        categories: ["failure"],
        nextAction: ["orchestration", "worker-show"],
      },
    ]);
  });
});
