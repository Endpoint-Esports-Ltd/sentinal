/**
 * Direct tests for the D12 preflight.
 *
 * ## Why this file exists when `lifecycle.test.ts` already walks the matrix
 *
 * `lifecycle.test.ts` exercises the matrix *through* `runtimeUp`, which is the
 * right place to prove the state machine. But `runtimeUp` can only ever observe
 * the preflight's decision through what it then DOES with it, so three things
 * stay invisible there and are asserted here instead:
 *
 * 1. **`readinessEndpoint` and the real `isPortBound`.** `runtimeUp` injects a
 *    stubbed port probe, so the actual socket logic — the connect-then-bind
 *    pair whose docstring makes a *measured* claim about BSD `SO_REUSEADDR` —
 *    has never been executed by a test. That claim is load-bearing: if it is
 *    wrong, an occupied port reads as free and issue #2 recurs.
 * 2. **What the refusals refuse to do.** "Fails" is one bit. "Fails AND never
 *    called teardown AND left the ownership record on disk" is the actual
 *    contract, and each conjunct is separately assertable here.
 * 3. **The `stale` + unenumerable-group row against the REAL
 *    `stopOwnedGroup`.** Stubbing `stop` proves preflight forwards a refusal;
 *    it does not prove the refusal happens. That row is the most dangerous in
 *    the file — it is the only one that can reach `kill -- -$PGID` with a dead
 *    leader — so it is wired to the real teardown here.
 *
 * ## Conventions
 *
 * Timeouts are shrunk (`startupTimeoutMs: 500`, `graceMs: 100`) rather than the
 * test budget being raised, matching `lifecycle.test.ts`. Every test gets a
 * fresh temp worktree, because half of these assertions are about whether a
 * file survived.
 *
 * ⛔ Every pid/pgid used with the real `stopOwnedGroup` is deliberately absurd
 * and every such row is one the ownership gate REFUSES, so no test in this file
 * can signal a real process even if a gate regressed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  preflight,
  readinessEndpoint,
  readinessPort,
  isPortBound,
  OCCUPIED_PORT_RULE,
  type Preflight,
  type PreflightDeps,
} from "./preflight.js";
import { writePidfile, runtimePidfilePath } from "./pidfile.js";
import type { RuntimePidfile } from "./pidfile.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";
import type { GroupProbes } from "./ownership.js";
import type { StartTimeProbes } from "./proc-start.js";
import type { StopResult } from "./teardown.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** An http-probe contract. The port is only ever read, never connected to. */
function cfg(over: Record<string, unknown> = {}): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    up: "run-the-thing",
    readiness: {
      type: "http",
      target: "http://127.0.0.1:45111/health",
      startupTimeoutMs: 500,
      pollIntervalMs: 50,
    },
    shutdown: { signal: "SIGTERM", graceMs: 100 },
    ...over,
  });
}

/**
 * An exec-probe contract — i.e. one for which `readinessEndpoint` is `null`.
 *
 * ⛔ Not a cosmetic variant. For these contracts `bound()` is hard-coded
 * `false`, so the port question degenerates into "always free" and the group
 * probe is the ONLY thing standing between a live process group and a deleted
 * ownership record.
 */
function execCfg(): RuntimeConfig {
  return cfg({
    readiness: {
      type: "exec",
      target: "nc -z 127.0.0.1 45111",
      startupTimeoutMs: 500,
      pollIntervalMs: 50,
    },
  });
}

const LEADER = 424242;
const GROUP = 424242;

function seedPidfile(
  worktree: string,
  over: Partial<RuntimePidfile> = {},
): RuntimePidfile {
  const entry: RuntimePidfile = {
    pid: LEADER,
    pgid: GROUP,
    startedAt: Date.now(),
    command: "run-the-thing",
    state: "ready",
    ...over,
  };
  writePidfile(worktree, entry);
  return entry;
}

/**
 * Put arbitrary bytes where the pidfile lives, creating `.sentinal/` first.
 * `writePidfile` cannot be used for the unreadable rows — its whole job is to
 * produce something readable.
 */
function seedRawPidfile(worktree: string, contents: string): void {
  const path = runtimePidfilePath(worktree);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

/** Probes that prove the recorded leader is alive AND belongs to `worktree`. */
function oursAndAlive(worktree: string): GroupProbes & StartTimeProbes {
  return {
    isAlive: () => true,
    commandOf: () => "node server.js",
    cwdOf: () => worktree,
    // The stubbed leader "started" when the record was written — without this
    // the H5 start-time check would run the real `ps` against a fake pid.
    startTimeOf: () => Date.now(),
  };
}

/**
 * Alive, but the command line and cwd point somewhere else entirely — the PID
 * has been recycled onto a stranger. This is the `foreign` row.
 */
const ALIVE_BUT_A_STRANGER: GroupProbes = {
  isAlive: () => true,
  commandOf: () => "/usr/local/pgsql/bin/postgres -D /var/db/pg",
  cwdOf: () => "/var/db/pg",
};

/** The leader is dead. Everything else about the group is per-test. */
function deadLeader(over: Partial<GroupProbes> = {}): GroupProbes {
  return {
    isAlive: (pid: number) => pid !== LEADER,
    commandOf: () => null,
    cwdOf: () => null,
    ...over,
  };
}

function okStop(over: Partial<StopResult> = {}): StopResult {
  return { ok: true, stopped: true, actions: [], warnings: [], ...over };
}

/** A `stop` stub that records whether — and how often — it was called. */
function stopSpy(result: StopResult = okStop()) {
  const calls: string[] = [];
  const fn = async (projectPath: string): Promise<StopResult> => {
    calls.push(projectPath);
    return result;
  };
  return { fn, calls };
}

const portAlways = (bound: boolean) => async () => bound;

// ─── Setup ──────────────────────────────────────────────────────────────────

let wt: string;

beforeEach(() => {
  wt = makeTmpDir("sentinal-preflight");
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

const pidfileExists = () => existsSync(runtimePidfilePath(wt));

// ─── readinessEndpoint / readinessPort ──────────────────────────────────────

describe("readinessEndpoint", () => {
  it("reads host and port out of an explicit http target", () => {
    expect(readinessEndpoint(cfg())).toEqual({
      host: "127.0.0.1",
      port: 45111,
    });
  });

  it("⛔ preserves the declared HOSTNAME rather than normalising to 127.0.0.1", () => {
    // `localhost` and `127.0.0.1` are usually the same thing and occasionally
    // are not (IPv6-only localhost). Probing the wrong one is either a spurious
    // hard failure or — far worse — a missed occupied port.
    const target = "http://localhost:8080/healthz";
    expect(
      readinessEndpoint(cfg({ readiness: { type: "http", target } })),
    ).toEqual({ host: "localhost", port: 8080 });
  });

  it("falls back to the scheme default port when the URL omits one", () => {
    expect(
      readinessEndpoint(
        cfg({ readiness: { type: "http", target: "http://example.test/up" } }),
      ),
    ).toEqual({ host: "example.test", port: 80 });
    expect(
      readinessEndpoint(
        cfg({ readiness: { type: "http", target: "https://example.test/up" } }),
      ),
    ).toEqual({ host: "example.test", port: 443 });
  });

  it("is null for an exec probe — there is no port to reason about", () => {
    expect(readinessEndpoint(execCfg())).toBeNull();
    expect(readinessPort(execCfg())).toBeNull();
  });

  it("is null for a contract with no readiness probe at all", () => {
    const bare = RuntimeConfigSchema.parse({ down: "stop-the-thing" });
    expect(readinessEndpoint(bare)).toBeNull();
    expect(readinessPort(bare)).toBeNull();
  });

  it("is null — never a throw — for a target that is not a URL", () => {
    const weird = cfg({ readiness: { type: "http", target: ":::not a url" } });
    expect(readinessEndpoint(weird)).toBeNull();
  });
});

// ─── isPortBound (real sockets) ─────────────────────────────────────────────

describe("isPortBound", () => {
  type Listener = { server: ReturnType<typeof Bun.serve>; port: number };
  let open: Listener | null = null;

  /**
   * Listen on an EPHEMERAL port (`port: 0`) and report which one the kernel
   * handed out. Never a hard-coded port: two of these tests assert "free", and
   * a fixed number is only free until something else on the machine takes it.
   */
  function serveOn(hostname: string): Listener {
    const server = Bun.serve({
      hostname,
      port: 0,
      fetch: () => new Response("x"),
    });
    const port = server.port;
    if (typeof port !== "number") {
      server.stop(true);
      throw new Error("Bun.serve did not report a port");
    }
    return { server, port };
  }

  afterEach(() => {
    open?.server.stop(true);
    open = null;
  });

  it("is false for a port nobody holds", async () => {
    // Take an ephemeral port and immediately give it back, so we know a real
    // allocator considered it free rather than picking a number and hoping.
    const { server, port } = serveOn("127.0.0.1");
    server.stop(true);

    expect(await isPortBound(port, "127.0.0.1")).toBe(false);
  });

  it("is true for a listener bound to 127.0.0.1", async () => {
    open = serveOn("127.0.0.1");
    expect(await isPortBound(open.port, "127.0.0.1")).toBe(true);
  });

  it("⛔ is true for a WILDCARD (0.0.0.0) listener probed on 127.0.0.1", async () => {
    // This is the row a bind-only probe gets WRONG on Darwin: BSD's
    // SO_REUSEADDR (which Node sets by default) permits binding the more
    // specific 127.0.0.1:P over an existing 0.0.0.0:P, so `listen()` succeeds
    // and the port reads as free. The connect probe is what makes this right,
    // and this test is the reason the connect probe may not be removed as a
    // redundant first step.
    open = serveOn("0.0.0.0");
    expect(await isPortBound(open.port, "127.0.0.1")).toBe(true);
  });

  it("reports the port free again once the listener stops", async () => {
    const { server, port } = serveOn("127.0.0.1");
    expect(await isPortBound(port, "127.0.0.1")).toBe(true);
    server.stop(true);
    expect(await isPortBound(port, "127.0.0.1")).toBe(false);
  });
});

// ─── The matrix: rows that PROCEED ──────────────────────────────────────────

describe("preflight — ready, alive, ours", () => {
  it("REUSES the stack and never calls teardown", async () => {
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(true),
      probes: oursAndAlive(wt),
    });

    expect(r.kind).toBe("reuse");
    if (r.kind !== "reuse") throw new Error("unreachable");
    expect(r.pid).toBe(LEADER);
    expect(r.pgid).toBe(GROUP);
    // The flag the caller needs: a reused stack must survive teardown.
    expect(r.actions.join(" ")).toContain("must NOT be torn down");
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(true);
  });

  it("reuses even though the port is bound — it is bound BY US", async () => {
    seedPidfile(wt, { state: "ready" });
    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(true),
      probes: oursAndAlive(wt),
    });
    expect(r.kind).toBe("reuse");
  });

  it("⛔ does NOT reuse a recycled PID whose start time contradicts the record (H5)", async () => {
    // Everything about this pid says "ours" — alive, worktree cwd — except
    // that it started an hour after the record was written. That is a recycled
    // PID wearing our leader's number, and it must route to the dead-leader
    // doctrine (stale), never to reuse.
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: {
        ...oursAndAlive(wt),
        startTimeOf: () => Date.now() + 3_600_000,
        listGroup: () => [],
      },
    });

    // Group enumerated empty + port free: the stale record is discarded and a
    // fresh spawn proceeds — without a single signal being sent.
    expect(r.kind).toBe("spawn");
    expect(stop.calls).toEqual([]);
    expect(r.actions.join(" ")).toContain("stale");
  });
});

describe("preflight — starting, alive, ours (interrupted startup)", () => {
  it("tears the interrupted group down, then spawns", async () => {
    seedPidfile(wt, { state: "starting" });
    const stop = stopSpy(
      okStop({ actions: ["sent SIGTERM to process group"] }),
    );

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: oursAndAlive(wt),
    });

    expect(r.kind).toBe("spawn");
    expect(stop.calls).toEqual([wt]);
    const said = r.actions.join(" ");
    expect(said).toContain("interrupted startup");
    // The teardown's own narration is forwarded, not swallowed.
    expect(said).toContain("sent SIGTERM to process group");
  });

  it("REFUSES to spawn when that teardown failed", async () => {
    seedPidfile(wt, { state: "starting" });
    const stop = stopSpy({
      ok: false,
      stopped: false,
      actions: [],
      warnings: [],
      reason: "REFUSING to signal process group 424242.",
    });

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: oursAndAlive(wt),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("Not spawning on top of it");
    expect(r.reason).toContain("REFUSING to signal process group 424242.");
  });

  it("REFUSES when the port is still bound after a successful teardown", async () => {
    seedPidfile(wt, { state: "starting" });

    const r = await preflight(wt, cfg(), {
      stop: stopSpy().fn,
      isPortBound: portAlways(true),
      probes: oursAndAlive(wt),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("Port 45111 is still bound");
    expect(r.reason).toContain(OCCUPIED_PORT_RULE);
  });
});

describe("preflight — no pidfile", () => {
  it("spawns on a free port, having done nothing at all", async () => {
    const stop = stopSpy();
    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
    });

    expect(r.kind).toBe("spawn");
    expect(r.actions).toEqual([]);
    expect(stop.calls).toEqual([]);
  });
});

// ─── The matrix: rows that REFUSE ───────────────────────────────────────────

describe("preflight — REFUSAL: port occupied with no pidfile", () => {
  it("fails loudly, carries the rule verbatim, and never suggests another port", async () => {
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(true),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    // Says WHICH port, and why Sentinal cannot simply take it over.
    expect(r.reason).toContain("Port 45111 is already in use");
    expect(r.reason).toContain("there is NO .sentinal/runtime.pid");
    expect(r.reason).toContain(OCCUPIED_PORT_RULE);
    // ⛔ Nothing was signalled and nothing was started.
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(false);
  });

  it("probes the port the CONTRACT declares, not one it chose", async () => {
    const seen: Array<[number, string | undefined]> = [];
    await preflight(wt, cfg({ readiness: "http://localhost:8080/health" }), {
      isPortBound: async (port, host) => {
        seen.push([port, host]);
        return true;
      },
    });
    expect(seen).toEqual([[8080, "localhost"]]);
  });

  it("cannot fail on an occupied port when the contract declares no http probe", async () => {
    // `bound()` is structurally false for an exec probe, so this row proceeds.
    // Asserted so that a future "just probe something" change has to confront
    // the fact that this is deliberate, not an oversight.
    const r = await preflight(wt, execCfg(), {
      isPortBound: portAlways(true),
    });
    expect(r.kind).toBe("spawn");
  });
});

describe("preflight — REFUSAL: pidfile alive but the command line does not match", () => {
  it("fails, signals nothing, and leaves the record for a human", async () => {
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(true),
      probes: ALIVE_BUT_A_STRANGER,
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("Not starting anything");
    expect(r.reason).toContain("not signalling it either");
    // Names the pid and the one manual remedy.
    expect(r.reason).toContain(String(LEADER));
    expect(r.reason).toContain("delete .sentinal/runtime.pid");

    // ⛔ The three conjuncts that make this a refusal rather than just a failure.
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(true);
    expect(r.actions).toEqual([]);
  });

  it("refuses on a state=starting foreign pid too — `state` is not evidence of ownership", async () => {
    seedPidfile(wt, { state: "starting" });
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: ALIVE_BUT_A_STRANGER,
    });

    expect(r.kind).toBe("fail");
    expect(stop.calls).toEqual([]);
  });

  it("treats a pid whose probes THROW as foreign, not as ours", async () => {
    // A probe that cannot answer is not evidence. `isAlive` throwing defaults
    // to ALIVE (which routes here) precisely so it cannot unlock the orphan reap.
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();
    const explode = (): never => {
      throw new Error("ps: command not found");
    };

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: { isAlive: explode, commandOf: explode, cwdOf: explode },
    });

    expect(r.kind).toBe("fail");
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(true);
  });
});

describe("preflight — REFUSAL: unreadable pidfile", () => {
  it("fails rather than guessing about a kill target", async () => {
    seedRawPidfile(wt, "{ not json at all");
    const stop = stopSpy();

    const r = await preflight(wt, cfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: oursAndAlive(wt),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("could not be parsed");
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(true);
  });

  it("also refuses a STRUCTURALLY wrong record, not just malformed JSON", async () => {
    // Valid JSON, wrong shape — a negative pid would otherwise be handed
    // straight to a signal path.
    seedRawPidfile(wt, JSON.stringify({ pid: -1, pgid: -1, state: "ready" }));
    const r = await preflight(wt, cfg(), {
      stop: stopSpy().fn,
      isPortBound: portAlways(false),
    });
    expect(r.kind).toBe("fail");
  });
});

describe("preflight — REFUSAL: leader dead and the group cannot be enumerated", () => {
  /**
   * ⛔ Wired to the REAL `stopOwnedGroup` (no `deps.stop`), because the claim
   * under test is that the refusal HAPPENS — that `maySignalGroup` treats a
   * failed `ps` as "unknown" rather than "empty" — not merely that preflight
   * forwards a refusal it was handed.
   *
   * `listGroup: () => null` is exactly the shape of a `ps` that is missing,
   * exited non-zero, or printed something unparsable.
   */
  const unenumerable = () => deadLeader({ listGroup: () => null });

  it("fails, and KEEPS the ownership record", async () => {
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(false),
      probes: unenumerable(),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("could not be ruled out as live");
    expect(r.reason).toContain("could not be enumerated");
    expect(r.reason).toContain("ownership record has been left in place");

    // ⛔ The load-bearing assertion. Discarding the record here would leave an
    // orphan that nothing can ever find again.
    expect(pidfileExists()).toBe(true);
  });

  it("adds the occupied-port rule when the port is ALSO bound", async () => {
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(true),
      probes: unenumerable(),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("held by an orphaned process group");
    expect(r.reason).toContain(OCCUPIED_PORT_RULE);
    expect(pidfileExists()).toBe(true);
  });

  it("refuses for an exec-probe contract too, where there is no port to fall back on", async () => {
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, execCfg(), {
      isPortBound: portAlways(false),
      probes: unenumerable(),
    });

    expect(r.kind).toBe("fail");
    expect(pidfileExists()).toBe(true);
  });

  it("refuses when the group is live but NO member is provably ours", async () => {
    // Enumeration succeeded; verification did not. Same refusal, different
    // reason — and the message must name the pids so a human can look.
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(true),
      probes: deadLeader({
        listGroup: () => [777001],
        isAlive: (pid: number) => pid !== LEADER,
        commandOf: () => "/usr/sbin/unrelated-daemon",
        cwdOf: () => "/",
      }),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("777001");
    expect(r.reason).toContain("pkill -f");
    expect(pidfileExists()).toBe(true);
  });
});

describe("preflight — REFUSAL: port still bound after the reap", () => {
  it("says the holder is NOT in that group, and carries the rule", async () => {
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, cfg(), {
      // The reap "succeeded" but the port never freed — so whatever holds it
      // was never ours to begin with.
      stop: stopSpy().fn,
      isPortBound: portAlways(true),
      probes: deadLeader({ listGroup: () => [777002] }),
    });

    expect(r.kind).toBe("fail");
    if (r.kind !== "fail") throw new Error("unreachable");
    expect(r.reason).toContain("STILL bound after signalling process group");
    expect(r.reason).toContain("not in that group");
    expect(r.reason).toContain(OCCUPIED_PORT_RULE);
  });
});

// ─── The matrix: stale rows that RECOVER ────────────────────────────────────

describe("preflight — leader dead", () => {
  it("discards the record and spawns when the port is free AND the group is empty", async () => {
    seedPidfile(wt, { state: "ready" });

    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(false),
      probes: deadLeader({ listGroup: () => [] }),
    });

    expect(r.kind).toBe("spawn");
    expect(r.actions.join(" ")).toContain("Removed a stale ownership record");
    expect(pidfileExists()).toBe(false);
  });

  it("reaps a verified orphan group, then spawns once the port frees", async () => {
    seedPidfile(wt, { state: "ready" });
    let bound = true;
    const stop = stopSpy(okStop({ actions: ["sent SIGTERM to group 424242"] }));

    const r = await preflight(wt, cfg(), {
      stop: async (p: string) => {
        bound = false; // the reap actually worked
        return stop.fn(p);
      },
      isPortBound: async () => bound,
      probes: deadLeader({ listGroup: () => [777003] }),
    });

    expect(r.kind).toBe("spawn");
    expect(r.actions.join(" ")).toContain("Reaped the orphaned process group");
    expect(stop.calls).toEqual([wt]);
  });

  it("⛔ does NOT discard the record for an exec contract whose group is still LIVE", async () => {
    // The row this guards: `bound()` is false for every exec contract, so a
    // port-only test would delete a live group's ownership record every time.
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();

    const r = await preflight(wt, execCfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: deadLeader({ listGroup: () => [777004] }),
    });

    expect(r.kind).toBe("spawn");
    const said = r.actions.join(" ");
    expect(said).not.toContain("Removed a stale ownership record");
    expect(said).toContain("Reaped the orphaned process group");
    expect(stop.calls).toEqual([wt]);
  });

  it("still discards the record for an exec contract whose group is GONE", async () => {
    seedPidfile(wt, { state: "ready" });
    const stop = stopSpy();

    const r = await preflight(wt, execCfg(), {
      stop: stop.fn,
      isPortBound: portAlways(false),
      probes: deadLeader({ listGroup: () => [] }),
    });

    expect(r.kind).toBe("spawn");
    expect(r.actions.join(" ")).toContain(
      "the contract declares no http probe",
    );
    expect(stop.calls).toEqual([]);
    expect(pidfileExists()).toBe(false);
  });

  it("treats a null pgid as an empty group — there is no group to enumerate", async () => {
    // Windows: `spawnDetached` makes no process-group guarantee, so `pgid` is
    // honestly `null` rather than a faked value that `kill -- -$PGID` would
    // aim at a stranger.
    seedPidfile(wt, { pgid: null, state: "ready" });

    const r = await preflight(wt, cfg(), {
      isPortBound: portAlways(false),
      probes: deadLeader({
        listGroup: () => {
          throw new Error("listGroup must not be consulted for a null pgid");
        },
      }),
    });

    expect(r.kind).toBe("spawn");
    expect(pidfileExists()).toBe(false);
  });
});

// ─── Cross-cutting properties ───────────────────────────────────────────────

describe("preflight — invariants across the whole matrix", () => {
  /** Every row, staged so the port is permanently occupied. */
  const rowsWithBoundPort: Array<[string, () => Promise<Preflight>]> = [
    ["absent", () => preflight(wt, cfg(), { isPortBound: portAlways(true) })],
    [
      "owned/starting",
      () => {
        seedPidfile(wt, { state: "starting" });
        return preflight(wt, cfg(), {
          stop: stopSpy().fn,
          isPortBound: portAlways(true),
          probes: oursAndAlive(wt),
        });
      },
    ],
    [
      "foreign",
      () => {
        seedPidfile(wt, { state: "ready" });
        return preflight(wt, cfg(), {
          stop: stopSpy().fn,
          isPortBound: portAlways(true),
          probes: ALIVE_BUT_A_STRANGER,
        });
      },
    ],
    [
      "unreadable",
      () => {
        seedRawPidfile(wt, "nope");
        return preflight(wt, cfg(), {
          stop: stopSpy().fn,
          isPortBound: portAlways(true),
        });
      },
    ],
    [
      "stale/unenumerable",
      () => {
        seedPidfile(wt, { state: "ready" });
        return preflight(wt, cfg(), {
          isPortBound: portAlways(true),
          probes: deadLeader({ listGroup: () => null }),
        });
      },
    ],
    [
      "stale/reaped-but-still-bound",
      () => {
        seedPidfile(wt, { state: "ready" });
        return preflight(wt, cfg(), {
          stop: stopSpy().fn,
          isPortBound: portAlways(true),
          probes: deadLeader({ listGroup: () => [777005] }),
        });
      },
    ],
  ];

  it.each(rowsWithBoundPort)(
    "⛔ never returns `spawn` while the port is bound (%s)",
    async (_row, run) => {
      const r = await run();
      expect(r.kind).not.toBe("spawn");
    },
  );

  it.each(rowsWithBoundPort.filter(([row]) => row !== "owned/starting"))(
    "every occupied-port failure carries OCCUPIED_PORT_RULE verbatim (%s)",
    async (row, run) => {
      const r = await run();
      if (r.kind === "reuse") throw new Error(`row ${row} unexpectedly reused`);
      if (r.kind === "fail" && r.reason.includes("Port ")) {
        expect(r.reason).toContain(OCCUPIED_PORT_RULE);
      }
    },
  );

  it("OCCUPIED_PORT_RULE forbids re-porting in as many words", () => {
    // The guidance being replaced said nothing either way, and an agent facing
    // a bound port with no instruction picks another one.
    expect(OCCUPIED_PORT_RULE).toContain("Do NOT start this on another port");
    expect(OCCUPIED_PORT_RULE).toContain("A free port proves nothing");
  });

  it("is inert for a contract with no readiness probe and no pidfile", async () => {
    const bare = RuntimeConfigSchema.parse({ down: "stop-the-thing" });
    const stop = stopSpy();
    const r = await preflight(wt, bare, {
      stop: stop.fn,
      isPortBound: async () => {
        throw new Error("no endpoint means the port must never be probed");
      },
    });
    expect(r.kind).toBe("spawn");
    expect(stop.calls).toEqual([]);
  });

  it("does not probe the port at all when the verdict is `foreign`", async () => {
    // A refusal that still went to the network would be a slower refusal for
    // no information gain.
    seedPidfile(wt, { state: "ready" });
    const deps: PreflightDeps = {
      stop: stopSpy().fn,
      isPortBound: async () => {
        throw new Error("port must not be probed on the foreign row");
      },
      probes: ALIVE_BUT_A_STRANGER,
    };
    const r = await preflight(wt, cfg(), deps);
    expect(r.kind).toBe("fail");
  });
});
