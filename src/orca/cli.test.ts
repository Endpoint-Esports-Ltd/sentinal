import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrcaRunner,
  parseLastJsonDocument,
  parseOrcaOutput,
  runOrca,
  type OrcaRunner,
  type OrcaRunOutput,
} from "./cli.js";
import type {
  OrcaCheckResult,
  OrcaRunCreateResult,
  OrcaTaskCreateResult,
  OrcaWorkerReadResult,
  OrcaWorkerStartReceipt,
} from "./types.js";

// Recorded from Orca 1.4.215 (spike run_93672f816e9f + read-only commands).
const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const out = (stdout: string, exitCode = 0, stderr = ""): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr,
});

/** A fake runner that records its calls and replays one output. Never spawns `orca`. */
function fakeRunner(result: OrcaRunOutput | (() => Promise<OrcaRunOutput>)) {
  const calls: { args: string[]; timeoutMs?: number }[] = [];
  const runner: OrcaRunner = async (args, opts) => {
    calls.push({ args, timeoutMs: opts?.timeoutMs });
    return typeof result === "function" ? result() : result;
  };
  return { runner, calls };
}

describe("parseLastJsonDocument", () => {
  it("parses a single pretty-printed document", () => {
    expect(parseLastJsonDocument('{\n  "a": 1\n}\n')).toEqual({ a: 1 });
  });

  it("returns the LAST document when several are present", () => {
    expect(parseLastJsonDocument('{"a":1}\n{"b":2}\n')).toEqual({ b: 2 });
  });

  it("skips NDJSON keepalive lines, even when they come last", () => {
    const text =
      '{"ok":true,"result":1}\n{"_keepalive":true,"_heartbeat":true,"elapsedMs":1}\n';
    expect(parseLastJsonDocument(text)).toEqual({ ok: true, result: 1 });
  });

  it("ignores leading and trailing non-JSON text", () => {
    const text = 'warning: something {not json}\n{"ok":true}\ntrailing text\n';
    expect(parseLastJsonDocument(text)).toEqual({ ok: true });
  });

  it("handles braces and escaped quotes inside strings", () => {
    const text = '{"msg":"a } \\" { b","n":{"x":[1,2]}}';
    expect(parseLastJsonDocument(text)).toEqual({
      msg: 'a } " { b',
      n: { x: [1, 2] },
    });
  });

  it("returns undefined when there is no JSON document", () => {
    expect(parseLastJsonDocument("")).toBeUndefined();
    expect(parseLastJsonDocument("command not found: orca")).toBeUndefined();
    expect(parseLastJsonDocument('{"_keepalive":true}')).toBeUndefined();
  });
});

describe("parseOrcaOutput — recorded spike shapes", () => {
  it("run-create: pretty success envelope", () => {
    const r = parseOrcaOutput<OrcaRunCreateResult>(
      out(fixture("run-create.json")),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.result.run.id).toBe("run_93672f816e9f");
    expect(r.result.run.coordinator_handle).toMatch(/^term_/);
  });

  it("task-create: task with JSON-string deps", () => {
    const r = parseOrcaOutput<OrcaTaskCreateResult>(
      out(fixture("task-create.json")),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.result.task.id).toBe("task_8b3fb8fed05a");
    expect(r.result.task.status).toBe("ready");
  });

  it("check --wait: NDJSON keepalives then a pretty final object (timeout checkpoint)", () => {
    const r = parseOrcaOutput<OrcaCheckResult>(
      out(fixture("check-wait-timeout.ndjson")),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.result.timedOut).toBe(true);
    expect(r.result.messages).toEqual([]);
  });

  it("check --wait: keepalives on stderr, final object on stdout", () => {
    const keepalives = fixture("check-wait-timeout.ndjson")
      .split("\n")
      .filter((l) => l.includes("_keepalive"))
      .join("\n");
    const r = parseOrcaOutput<OrcaCheckResult>(
      out(fixture("check-worker-done.json"), 0, keepalives),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.result.messages[0].type).toBe("worker_done");
    expect(JSON.parse(r.result.messages[0].payload ?? "{}")).toEqual({
      taskId: "task_8b3fb8fed05a",
      dispatchId: "ctx_4c968df3149b",
      outcome: "succeeded",
      filesModified: ["spike/worker-a.txt"],
    });
  });

  it("worker-start failed receipt stays ok:true (the envelope succeeded; the start did not)", () => {
    const r = parseOrcaOutput<OrcaWorkerStartReceipt>(
      out(fixture("worker-start-failed.json")),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.result.state).toBe("failed");
    expect(r.result.failedStage).toBe("agent_readiness");
    expect(r.result.lastError).toBe("terminal_handle_stale");
    expect(r.result.residualResources.map((x) => x.kind)).toContain("terminal");
  });

  it("worker-start ready receipt", () => {
    const r = parseOrcaOutput<OrcaWorkerStartReceipt>(
      out(fixture("worker-start-ready.json")),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.result.state).toBe("ready");
    expect(r.result.dispatchId).toBe("ctx_4c968df3149b");
    expect(r.result.residualResources).toEqual([]);
  });

  it("worker-read transcript", () => {
    const r = parseOrcaOutput<OrcaWorkerReadResult>(
      out(fixture("worker-read-auth-stall.json")),
    );
    if (!r.ok) throw new Error("expected ok");
    const last = r.result.transcript?.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.blocks[0].text).toContain("401");
  });

  it("error envelope: task_not_startable with unmetDependencies (exit 1)", () => {
    const r = parseOrcaOutput(
      out(fixture("worker-start-not-startable.json"), 1),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("task_not_startable");
    expect(r.error.message).toContain("only a ready Task can start");
    expect(r.error.data?.unmetDependencies).toEqual(["task_8b3fb8fed05a"]);
  });

  it("error envelope without data (dispatch_not_found)", () => {
    const r = parseOrcaOutput(out(fixture("worker-show-not-found.json"), 1));
    if (r.ok) throw new Error("expected error");
    expect(r.error).toEqual({
      code: "dispatch_not_found",
      message: "Worker Dispatch ctx_000000000000 was not found.",
    });
  });

  it("error envelope from the CLI itself (unknown command)", () => {
    const r = parseOrcaOutput(out(fixture("unknown-command.json"), 1));
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_argument");
  });

  it("non-JSON output → orca_bad_output with a tail of what was printed", () => {
    const r = parseOrcaOutput(out("Segmentation fault", 139, "boom"));
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_bad_output");
    expect(r.error.message).toContain("139");
    expect(r.error.message).toContain("boom");
  });

  it("a JSON document that is not an envelope → orca_bad_output", () => {
    const r = parseOrcaOutput(out('{"hello":"world"}'));
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_bad_output");
  });

  it("an error envelope with a malformed error object still yields a string code", () => {
    const r = parseOrcaOutput(out('{"ok":false,"error":"nope"}', 1));
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_error");
    expect(r.error.message).toBe("nope");
  });

  it("exit 127 with no JSON → orca_unavailable", () => {
    const r = parseOrcaOutput(out("", 127, "orca: command not found"));
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_unavailable");
  });
});

describe("runOrca", () => {
  it("appends --json once and forwards the timeout", async () => {
    const { runner, calls } = fakeRunner(out(fixture("run-create.json")));
    await runOrca(["orchestration", "run-current"], {
      runner,
      timeoutMs: 1234,
    });
    await runOrca(["status", "--json"], { runner });
    expect(calls[0].args).toEqual(["orchestration", "run-current", "--json"]);
    expect(calls[0].timeoutMs).toBe(1234);
    expect(calls[1].args).toEqual(["status", "--json"]);
  });

  it("a runner that throws ENOENT → orca_unavailable, never throws", async () => {
    const runner: OrcaRunner = async () => {
      throw Object.assign(new Error("spawn orca ENOENT"), { code: "ENOENT" });
    };
    const r = await runOrca(["status"], { runner });
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_unavailable");
    expect(r.error.message).toContain("ENOENT");
  });

  it("a runner reporting timedOut → orca_timeout", async () => {
    const { runner } = fakeRunner({
      exitCode: 143,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const r = await runOrca(["orchestration", "check", "--wait"], {
      runner,
      timeoutMs: 50,
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_timeout");
  });

  it("a runner that hangs past the timeout → orca_timeout (backstop)", async () => {
    const { runner } = fakeRunner(() => new Promise<OrcaRunOutput>(() => {}));
    const r = await runOrca(["status"], { runner, timeoutMs: 20, graceMs: 10 });
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_timeout");
  });

  it("a timed-out runner that still printed a final envelope keeps the envelope", async () => {
    const { runner } = fakeRunner({
      ...out(fixture("check-worker-done.json")),
      timedOut: true,
    });
    const r = await runOrca(["orchestration", "check"], { runner });
    expect(r.ok).toBe(true);
  });
});

describe("createOrcaRunner (spawn path, fake binary — never the real orca)", () => {
  function fakeBinary(script: string): { bin: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "fake-orca-"));
    const bin = join(dir, "orca");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return {
      bin,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("captures stdout, stderr, exit code and passes args + env", async () => {
    const { bin, cleanup } = fakeBinary(
      'echo "{\\"_keepalive\\":true}" 1>&2; printf \'{"ok":true,"result":{"args":"%s","v":"%s"}}\' "$*" "$FAKE_V"; exit 0',
    );
    try {
      const runner = createOrcaRunner({ binary: bin });
      const r = await runOrca<{ args: string; v: string }>(["status"], {
        runner,
        env: { FAKE_V: "42" },
      });
      expect(r).toEqual({
        ok: true,
        result: { args: "status --json", v: "42" },
      });
    } finally {
      cleanup();
    }
  });

  it("kills the process at the deadline → orca_timeout", async () => {
    // A grandchild keeps the pipes open after the kill: the drain must be bounded.
    const { bin, cleanup } = fakeBinary("sleep 5 & wait");
    try {
      const started = Date.now();
      const r = await runOrca(["status"], {
        runner: createOrcaRunner({ binary: bin }),
        timeoutMs: 100,
      });
      // Below the 2 s backstop grace: the runner itself must kill, not runOrca give up.
      expect(Date.now() - started).toBeLessThan(1500);
      if (r.ok) throw new Error("expected error");
      expect(r.error.code).toBe("orca_timeout");
    } finally {
      cleanup();
    }
  });

  it("a missing binary → orca_unavailable", async () => {
    const r = await runOrca(["status"], {
      runner: createOrcaRunner({ binary: "/nonexistent/dir/orca" }),
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("orca_unavailable");
  });
});
