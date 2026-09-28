import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { collectStalls, stallVerdict, DEFAULT_MAX_IDLE_MS } from "./stall.js";
import type {
  OrcaTranscriptMessage,
  OrcaWorkerListRow,
  OrcaWorkerReadResult,
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
