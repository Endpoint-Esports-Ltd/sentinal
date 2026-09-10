/**
 * The D12 preflight matrix and the `up` state machine.
 *
 * ⛔ Every row of the matrix gets its own test, because the rows disagree about
 * the single most dangerous question in this phase — *may we signal?* — and a
 * row that silently collapses into its neighbour is exactly how a `runtime_up`
 * ends up killing a stranger's process group or improvising a port.
 *
 * Timeouts are shrunk (`startupTimeoutMs: 500`, `pollIntervalMs: 50`,
 * `graceMs: 100`) rather than the test budget being raised: `bun test` defaults
 * to 5s, and a `state=starting` pidfile left behind by a timed-out test
 * cascades into every later test in the block.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { runtimeUp, runtimeStop, readinessPort } from "./lifecycle.js";
import { readPidfile, writePidfile, runtimePidfilePath } from "./pidfile.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";
import type { LoadedRuntimeConfig } from "./loader.js";
import type { StopResult } from "./teardown.js";
import type { SpawnDetachedResult } from "./spawn.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function cfg(over: Record<string, unknown> = {}): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    up: "run-the-thing",
    readiness: {
      type: "http",
      target: "http://127.0.0.1:45999/health",
      startupTimeoutMs: 500,
      pollIntervalMs: 50,
    },
    shutdown: { signal: "SIGTERM", graceMs: 100 },
    ...over,
  });
}

function loaded(config: RuntimeConfig | null, over = {}): LoadedRuntimeConfig {
  return {
    path: "/x/.sentinal/runtime.json",
    relPath: ".sentinal/runtime.json",
    configured: config !== null,
    config,
    slot: 3,
    sharedResources: [],
    unknownResources: [],
    warnings: [],
    error: null,
    ...over,
  };
}

function okStop(over: Partial<StopResult> = {}): StopResult {
  return { ok: true, stopped: true, actions: [], warnings: [], ...over };
}

/** A spawn stub that records its calls and never starts a real process. */
function fakeSpawn(pid = 4242) {
  const calls: {
    worktreePath: string;
    command: string;
    slot?: number | null;
  }[] = [];
  const fn = (opts: {
    worktreePath: string;
    command: string;
    slot?: number | null;
  }): SpawnDetachedResult => {
    calls.push(opts);
    return {
      pid,
      pgid: pid,
      logPath: join(opts.worktreePath, ".sentinal/runtime.log"),
      command: opts.command,
      exitCode: () => null,
      exited: Promise.resolve(0),
    };
  };
  return { fn, calls };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("readinessPort", () => {
  it("reads the port out of an http probe target", () => {
    expect(readinessPort(cfg())).toBe(45999);
  });

  it("falls back to the scheme default when the URL omits a port", () => {
    expect(readinessPort(cfg({ readiness: "http://localhost/health" }))).toBe(
      80,
    );
    expect(readinessPort(cfg({ readiness: "https://localhost/health" }))).toBe(
      443,
    );
  });

  it("is null for an exec probe — there is no port to reason about", () => {
    expect(
      readinessPort(
        cfg({ readiness: { type: "exec", target: "nc -z localhost 1" } }),
      ),
    ).toBeNull();
  });
});

describe("runtimeUp", () => {
  let wt: string;

  beforeEach(() => {
    // Fresh temp worktree per test — a leftover `state=starting` pidfile is
    // itself a concurrency guard and would cascade.
    wt = makeTmpDir("sentinal-runtime-up");
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
  });

  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  // ── Inert paths ──────────────────────────────────────────────────────────

  it("is an inert success when there is no runtime contract", async () => {
    const spawn = fakeSpawn();
    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(null, { configured: false }),
      spawn: spawn.fn,
    });
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(false);
    expect(r.started).toBe(false);
    expect(spawn.calls).toHaveLength(0);
  });

  it("fails when the contract exists but could not be used", async () => {
    const r = await runtimeUp(wt, {
      loadConfig: () =>
        loaded(null, { configured: true, error: "bad token in `up`" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("bad token");
  });

  it("is an inert success when the contract declares no `up`", async () => {
    const spawn = fakeSpawn();
    const r = await runtimeUp(wt, {
      loadConfig: () =>
        loaded(RuntimeConfigSchema.parse({ down: "docker compose down" })),
      spawn: spawn.fn,
    });
    expect(r.ok).toBe(true);
    expect(r.started).toBe(false);
    expect(spawn.calls).toHaveLength(0);
  });

  // ── Preflight row: pidfile ready + owned → REUSE ─────────────────────────

  it("REUSES a ready, alive, matching stack and never tears it down", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        return okStop();
      },
      probes: {
        isAlive: () => true,
        commandOf: () => `sh -c cd ${wt}`,
        startTimeOf: () => Date.now(),
      },
    });

    expect(r.ok).toBe(true);
    expect(r.reused).toBe(true);
    expect(r.started).toBe(false);
    // ⛔ Killing what we did not start is the same error class as `pkill -f`.
    expect(stopCalls).toBe(0);
    expect(spawn.calls).toHaveLength(0);
  });

  // ── Preflight row: pidfile starting + owned → tear down, respawn ─────────

  it("recovers an interrupted startup: tears the group down, then spawns fresh", async () => {
    // The record is AGED past the startup budget — a fresh `starting` record
    // is presumed to be a concurrent runtime_up mid-poll (see next test).
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now() - 120_000,
      command: "run-the-thing",
      state: "starting",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        rmSync(runtimePidfilePath(wt), { force: true });
        return okStop();
      },
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      isPortBound: async () => false,
      probes: {
        isAlive: () => true,
        commandOf: () => `sh -c cd ${wt}`,
        startTimeOf: () => Date.now() - 120_000,
      },
    });

    expect(stopCalls).toBe(1);
    expect(spawn.calls).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.started).toBe(true);
  });

  it("⛔ does NOT tear down a FRESH `starting` record — that is a concurrent runtime_up, not an interrupted one", async () => {
    // M4c: without this gate the LOSER of a claim race re-runs preflight,
    // reads the winner's seconds-old `starting` record, and "recovers" it —
    // tearing down the very stack the winner just started.
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "starting",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        return okStop();
      },
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      isPortBound: async () => false,
      probes: {
        isAlive: () => true,
        commandOf: () => `sh -c cd ${wt}`,
        startTimeOf: () => Date.now(),
      },
    });

    expect(r.ok).toBe(false);
    expect(stopCalls).toBe(0);
    expect(spawn.calls).toHaveLength(0);
    expect(r.reason?.toLowerCase()).toContain("runtime_up");
    // The winner's record is untouched.
    expect(readPidfile(wt)!.pid).toBe(999);
  });

  // ── The claim race (M4c) ─────────────────────────────────────────────────

  it("⛔ two concurrent runtime_ups: exactly one spawns, the loser reports cleanly", async () => {
    const calls: unknown[] = [];
    const mkDeps = (pid: number): Parameters<typeof runtimeUp>[1] => ({
      loadConfig: () => loaded(cfg()),
      spawn: (opts) => {
        calls.push(opts);
        return {
          pid,
          pgid: pid,
          logPath: join(opts.worktreePath, ".sentinal/runtime.log"),
          command: opts.command,
          exitCode: () => null,
          exited: Promise.resolve(0),
        };
      },
      isPortBound: async () => false,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      probes: {
        isAlive: () => true,
        commandOf: () => `sh -c cd ${wt}`,
        cwdOf: () => wt,
        startTimeOf: () => Date.now(),
      },
    });

    const [a, b] = await Promise.all([
      runtimeUp(wt, mkDeps(4242)),
      runtimeUp(wt, mkDeps(5555)),
    ]);

    // ⛔ Exactly ONE spawn. Before the exclusive claim, both passed preflight,
    // both spawned, and the loser's detached group had no ownership record.
    expect(calls).toHaveLength(1);
    const winner = a.started ? a : b;
    const loser = a.started ? b : a;
    expect(winner.ok).toBe(true);
    expect(winner.started).toBe(true);
    expect(loser.started).toBe(false);
    // The loser either adopted the winner's stack or failed with a reason —
    // never a silent orphan.
    if (!loser.ok) expect(loser.reason).toBeTruthy();
    // No orphan record: the pidfile describes the winner's group.
    expect(readPidfile(wt)!.pid).toBe(winner.pid!);
  });

  // ── Preflight row: alive but cmdline mismatch → FAIL ─────────────────────

  it("fails on a live pid that cannot be proven ours, and signals nothing", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        return okStop();
      },
      probes: {
        isAlive: () => true,
        commandOf: () => "/usr/bin/postgres -D /var/lib/pg",
        cwdOf: () => "/var/lib/pg",
      },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("999");
    expect(stopCalls).toBe(0);
    expect(spawn.calls).toHaveLength(0);
  });

  it("fails on an unreadable pidfile rather than guessing", async () => {
    writeFileSync(runtimePidfilePath(wt), "{ not json");
    const spawn = fakeSpawn();
    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
    });
    expect(r.ok).toBe(false);
    expect(spawn.calls).toHaveLength(0);
  });

  // ── Preflight row: leader dead, port still bound → orphan reap ───────────

  it("reaps a verified orphan group, then spawns once the port frees", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;
    let bound = true;

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        bound = false;
        rmSync(runtimePidfilePath(wt), { force: true });
        return okStop();
      },
      isPortBound: async () => bound,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      probes: { isAlive: () => false },
    });

    expect(stopCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(spawn.calls).toHaveLength(1);
  });

  it("REFUSES to spawn when the orphan reap could not verify a group member", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      // The real gate refuses; the stub reports exactly what it reports.
      stop: async () =>
        okStop({
          ok: false,
          stopped: false,
          reason: "REFUSING to signal process group 999.",
        }),
      isPortBound: async () => true,
      probes: { isAlive: () => false },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("999");
    // ⛔ "Do not spawn" is the whole point of this row.
    expect(spawn.calls).toHaveLength(0);
  });

  it("fails naming the pgid when the port is STILL bound after the reap", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 777,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      stop: async () => okStop(),
      isPortBound: async () => true,
      probes: { isAlive: () => false },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("777");
    expect(spawn.calls).toHaveLength(0);
  });

  // ── Preflight row: stale pidfile, port free → delete and spawn ───────────

  it("deletes a stale pidfile and spawns when the port is free", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "run-the-thing",
      state: "ready",
    });
    const spawn = fakeSpawn();

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      // Port free AND the group is enumerated as empty — both halves are
      // required before the ownership record may be discarded.
      probes: { isAlive: () => false, listGroup: () => [] },
    });

    expect(r.ok).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    // The record now describes the NEW process, not the stale one.
    expect(readPidfile(wt)!.pid).toBe(4242);
  });

  /**
   * ⛔ The port probe is a proxy for liveness that DOES NOT EXIST for an
   * `exec`-probe contract: `readinessEndpoint` is null, so `bound()` is
   * hard-coded false and the "port is free → delete the record and spawn" row
   * fires unconditionally. The group-member probe is the question that can
   * actually be asked, and it is already written.
   */
  it("⛔ does NOT discard the record for an exec-probe contract whose GROUP is still live", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "npm run dev",
      state: "ready",
    });
    const spawn = fakeSpawn();
    let stopCalls = 0;

    const r = await runtimeUp(wt, {
      loadConfig: () =>
        loaded(cfg({ readiness: { type: "exec", target: "pg_isready" } })),
      spawn: spawn.fn,
      stop: async () => {
        stopCalls++;
        return okStop({
          ok: false,
          stopped: false,
          reason: "REFUSING to signal process group 999.",
        });
      },
      probes: {
        isAlive: (pid) => pid !== 999, // dead leader, live members
        listGroup: () => [1001],
      },
    });

    // The reap was attempted through the ownership-verified gate...
    expect(stopCalls).toBe(1);
    // ...it refused, so nothing may be spawned on top of a possibly-live stack
    expect(r.ok).toBe(false);
    expect(spawn.calls).toHaveLength(0);
    // ...and the ownership record — the only thing that can find that group
    // again — is still on disk.
    expect(readPidfile(wt)!.pid).toBe(999);
  });

  it("still discards the record for an exec-probe contract whose group is GONE", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "npm run dev",
      state: "ready",
    });
    const spawn = fakeSpawn();

    const r = await runtimeUp(wt, {
      loadConfig: () =>
        loaded(cfg({ readiness: { type: "exec", target: "pg_isready" } })),
      spawn: spawn.fn,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
      probes: { isAlive: () => false, listGroup: () => [] },
    });

    expect(r.ok).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    expect(readPidfile(wt)!.pid).toBe(4242);
  });

  // ── Preflight row: port occupied, NO pidfile → hard failure ──────────────

  it("fails loudly on an occupied port with no pidfile, and never re-ports", async () => {
    const spawn = fakeSpawn();
    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => true,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("45999");
    expect(spawn.calls).toHaveLength(0);
    // ⛔ The message must forbid the improvisation, not merely omit it — the
    // guidance being replaced implicitly authorised picking another port.
    expect(r.reason!.toLowerCase()).toContain("another port");
  });

  // ── Startup ──────────────────────────────────────────────────────────────

  it("writes the pidfile with state=starting BEFORE the first readiness poll", async () => {
    const spawn = fakeSpawn();
    let stateAtFirstPoll: string | undefined;

    await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => {
        stateAtFirstPoll = readPidfile(wt)?.state;
        return { ready: true, attempts: 1, elapsedMs: 1 };
      },
    });

    // ⛔ Writing it only on success leaves the whole startup window with a
    // detached group and no ownership record — and then wedges the worktree.
    expect(stateAtFirstPoll).toBe("starting");
  });

  it("flips the pidfile to state=ready once the probe passes", async () => {
    const spawn = fakeSpawn();
    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => ({ ready: true, attempts: 2, elapsedMs: 9 }),
    });

    expect(r.ok).toBe(true);
    expect(r.started).toBe(true);
    expect(r.pid).toBe(4242);
    expect(readPidfile(wt)!.state).toBe("ready");
  });

  it("passes the spawned leader's exit code through to the readiness poller", async () => {
    const spawn = fakeSpawn();
    let sawLeaderHandle = false;
    await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async (opts) => {
        sawLeaderHandle = typeof opts.leaderExitCode === "function";
        return { ready: true, attempts: 1, elapsedMs: 1 };
      },
    });
    // Without it, a crashed `up` burns the whole 60s budget instead of failing
    // fast, and a zero-exit detaching starter cannot be told apart from a crash.
    expect(sawLeaderHandle).toBe(true);
  });

  it("runs the compensating teardown and returns a log tail on readiness timeout", async () => {
    const spawn = fakeSpawn();
    let stopCalls = 0;
    writeFileSync(join(wt, ".sentinal", "runtime.log"), "boom: EADDRINUSE\n");

    const r = await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => ({
        ready: false,
        attempts: 10,
        elapsedMs: 500,
        reason: "timed out after 500ms",
      }),
      stop: async () => {
        stopCalls++;
        return okStop();
      },
    });

    expect(r.ok).toBe(false);
    // A partial start still started things — compensating teardown is mandatory.
    expect(stopCalls).toBe(1);
    expect(r.reason).toContain("timed out");
    expect(r.logTail).toContain("EADDRINUSE");
  });

  it("exports SENTINAL_WORKTREE_SLOT for scripts the up command invokes", async () => {
    const spawn = fakeSpawn();
    await runtimeUp(wt, {
      loadConfig: () => loaded(cfg()),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
    });
    expect(spawn.calls[0]!.slot).toBe(3);
  });

  it("spawns the contract's `up` VERBATIM — no port is ever rewritten", async () => {
    const spawn = fakeSpawn();
    await runtimeUp(wt, {
      loadConfig: () => loaded(cfg({ up: "docker compose -p app-3 up -d" })),
      spawn: spawn.fn,
      isPortBound: async () => false,
      awaitReady: async () => ({ ready: true, attempts: 1, elapsedMs: 1 }),
    });
    expect(spawn.calls[0]!.command).toBe("docker compose -p app-3 up -d");
  });
});

describe("runtimeStop", () => {
  let wt: string;

  beforeEach(() => {
    wt = makeTmpDir("sentinal-runtime-stop");
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
  });

  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  it("is a fast no-op, twice, when nothing was ever started", async () => {
    const started = Date.now();
    const first = await runtimeStop(wt);
    const second = await runtimeStop(wt);
    expect(first.ok).toBe(true);
    expect(first.stopped).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.stopped).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("removes the ownership record for a group that is already gone", async () => {
    writePidfile(wt, {
      pid: 999,
      pgid: 999,
      startedAt: Date.now(),
      command: "x",
      state: "ready",
    });
    const r = await runtimeStop(wt, {
      probes: { isAlive: () => false, listGroup: () => [] },
    });
    expect(r.ok).toBe(true);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });
});

// ─── Against a real process ─────────────────────────────────────────────────

/**
 * The stubbed tests above prove the matrix; these prove the wiring.
 *
 * ⛔ Kept deliberately small (two tests) because each one starts a real
 * detached process group. `afterEach` SIGKILLs the group as a backstop — a
 * leaked server would bind a port for every subsequent run on this machine.
 */
describe("runtimeUp / runtimeStop against a real server", () => {
  let wt: string;
  let port: number;
  const started: number[] = [];

  function contract(startupTimeoutMs = 4000): void {
    writeFileSync(
      join(wt, "server.js"),
      `Bun.serve({ port: ${port}, fetch: () => new Response("ok") });\n` +
        `await new Promise(() => {});\n`,
    );
    writeFileSync(
      join(wt, ".sentinal", "runtime.json"),
      JSON.stringify({
        up: "bun run server.js",
        readiness: {
          type: "http",
          target: `http://127.0.0.1:${port}/`,
          startupTimeoutMs,
          pollIntervalMs: 50,
        },
        shutdown: { signal: "SIGTERM", graceMs: 500 },
      }),
    );
  }

  beforeEach(() => {
    wt = makeTmpDir("sentinal-runtime-real");
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    port = 45000 + Math.floor(Math.random() * 2000);
  });

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(wt, { recursive: true, force: true });
  });

  it("starts, is reused on a second call, and is stopped by runtime_stop", async () => {
    contract();

    const up = await runtimeUp(wt);
    if (up.pid) started.push(up.pid);
    expect(up.ok).toBe(true);
    expect(up.started).toBe(true);
    expect(readPidfile(wt)!.state).toBe("ready");

    // Second call adopts rather than double-starts — and must NOT stop it.
    const again = await runtimeUp(wt);
    expect(again.ok).toBe(true);
    expect(again.reused).toBe(true);
    expect(again.started).toBe(false);
    expect(readPidfile(wt)!.pid).toBe(up.pid!);

    const stop = await runtimeStop(wt);
    expect(stop.ok).toBe(true);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);

    // Idempotent: a second stop is a clean no-op, not an error.
    expect((await runtimeStop(wt)).ok).toBe(true);
  }, 20_000);

  it("REFUSES to start on an occupied port with no pidfile, and never re-ports", async () => {
    const squatter = Bun.serve({ port, fetch: () => new Response("mine") });
    try {
      contract(500);
      const r = await runtimeUp(wt);
      if (r.pid) started.push(r.pid);

      expect(r.ok).toBe(false);
      expect(r.reason).toContain(String(port));
      expect(r.reason!.toLowerCase()).toContain("another port");
      // Nothing was recorded, because nothing was started.
      expect(existsSync(runtimePidfilePath(wt))).toBe(false);
      // ⛔ And the squatter is untouched — we neither killed it nor moved.
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
        "mine",
      );
    } finally {
      squatter.stop(true);
    }
  }, 20_000);
});

// ─── The rule, asserted against the source ──────────────────────────────────

describe("no code path improvises a port", () => {
  it("contains no port arithmetic or free-port search anywhere in src/runtime/", async () => {
    // ⛔ A behavioural test can only show that the paths it happens to exercise
    // do not re-port. The DoD is stronger than that — "no alternative port is
    // attempted ANYWHERE in the code path" — so this reads the source.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = import.meta.dir;
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      // Strip comments — the docblocks say "no `findFreePort`" out loud, and
      // a scanner that cannot tell a prohibition from an implementation is
      // useless.
      const text = readFileSync(join(dir, f), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // `port + 1`, `port++`, `findFreePort`, `getFreePort`, `nextPort`
      if (
        /\bport\s*\+\+|\bport\s*\+\s*\d|\b(find|get|next|pick|alloc\w*)[A-Za-z]*Port\b/i.test(
          text,
        )
      ) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
