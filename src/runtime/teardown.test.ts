/**
 * Teardown — the correct alternative to `pkill -f`, which is the entire reason
 * this master plan exists.
 *
 * Every test here is ultimately about one rule: **never signal a PID or PGID
 * without ownership verification, and REFUSE when verification is impossible.**
 * The dangerous case is a dead leader: leader-PID verification is then
 * structurally impossible, and PGIDs come from the same wrapping space as PIDs,
 * so a dead leader's pgid can already belong to a stranger's group.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopOwnedGroup, assertStillAlive } from "./teardown.js";
import { spawnDetached } from "./spawn.js";
import { writePidfile, runtimePidfilePath } from "./pidfile.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";

let wt: string;
const started: number[] = [];

beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-teardown-")));
});

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(wt, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

/** ⛔ Shrunk from the 10000ms production default — `bun test` gives us 5s. */
function config(over: Record<string, unknown> = {}): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    shutdown: { signal: "SIGTERM", graceMs: 100 },
    ...over,
  });
}

const loading = (c: RuntimeConfig | null) => () => ({ config: c });

function pidfileFor(
  pid: number,
  pgid: number | null,
  state: "starting" | "ready" = "ready",
) {
  writePidfile(wt, {
    pid,
    pgid,
    startedAt: Date.now(),
    command: "npm run dev",
    state,
  });
}

// ─── Fast no-op ─────────────────────────────────────────────────────────────

describe("stopOwnedGroup — no pidfile", () => {
  it("is a FAST no-op, not a graceMs-long wait (Pre-Mortem #2)", async () => {
    // ⛔ `abandon` calls this on EVERY worktree, including ones that never
    // started a runtime. Paying the grace period there would make the normal
    // end-of-spec exit feel broken.
    const started = Date.now();
    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config({ down: "docker compose down" })),
      runShell: async () => {
        throw new Error("`down` must NOT run when nothing was started");
      },
      signalFn: () => {
        throw new Error("nothing may be signalled");
      },
    });

    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("is idempotent — safe to call twice", async () => {
    const once = await stopOwnedGroup(wt, { loadConfig: loading(config()) });
    const twice = await stopOwnedGroup(wt, { loadConfig: loading(config()) });
    expect(once.ok).toBe(true);
    expect(twice.ok).toBe(true);
  });
});

// ─── Ownership refusals ─────────────────────────────────────────────────────

describe("stopOwnedGroup — refuses to signal what it cannot prove", () => {
  it("REFUSES a live pid whose cmdline and cwd do not reference the worktree", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: { commandOf: () => "/usr/sbin/cupsd -l", cwdOf: () => "/" },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(signals).toEqual([]);
    expect(r.reason).toContain(String(process.pid));
    // The record is LEFT in place — deleting it would erase the only evidence
    // that something may still be running.
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("REFUSES when ownership cannot be checked at all (no `ps`, no `lsof`)", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        commandOf: () => {
          throw new Error("ps unavailable");
        },
        cwdOf: () => {
          throw new Error("lsof unavailable");
        },
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(signals).toEqual([]);
  });

  it("REFUSES an unreadable pidfile rather than guessing", async () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(runtimePidfilePath(wt), "{ not json");

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      signalFn: () => {
        throw new Error("nothing may be signalled");
      },
    });
    expect(r.ok).toBe(false);
  });
});

// ─── Orphan reap: the dangerous row ─────────────────────────────────────────

describe("stopOwnedGroup — dead leader, surviving group", () => {
  it("REFUSES to kill the group when NO live member references this worktree", async () => {
    // ⛔ THE dangerous case. The leader is dead, so leader-PID verification is
    // structurally impossible; the pgid may already have been recycled onto an
    // unrelated group. Zero verified members MUST mean refuse.
    pidfileFor(999_001, 999_001);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: (pid) => pid !== 999_001, // leader dead, members alive
        listGroup: () => [999_002, 999_003],
        commandOf: () => "/usr/sbin/cupsd -l",
        cwdOf: () => "/",
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(signals).toEqual([]);
    expect(r.reason).toContain("999001"); // names the pgid
    expect(r.reason?.toLowerCase()).toContain("refus");
  });

  it("kills the group when at least ONE live member is provably ours", async () => {
    pidfileFor(999_001, 999_001);
    const signals: [number, string][] = [];
    let signalled = false;

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: (pid) => pid !== 999_001 && !signalled,
        listGroup: () => [999_002, 999_003],
        commandOf: (pid) =>
          pid === 999_003 ? `node server.js ${wt}` : "cupsd",
        cwdOf: () => null,
      },
      signalFn: (t, s) => {
        signals.push([t, s as string]);
        signalled = true; // the group dies to the first signal
      },
    });

    expect(r.ok).toBe(true);
    expect(signals[0]).toEqual([-999_001, "SIGTERM"]);
  });

  /**
   * ⛔ THE must_fix, at the level where it does the damage.
   *
   * "`ps` could not answer" is NOT "the group is gone". Reporting success here
   * and deleting `.sentinal/runtime.pid` destroys the only ownership record for
   * a group that may still be running — the exact failure this module's own
   * docstring says must never happen ("Answering 'success' to the second leaves
   * an orphan running while reporting it cleaned up").
   */
  it("⛔ REFUSES and KEEPS the pidfile when the group cannot be ENUMERATED", async () => {
    pidfileFor(999_001, 999_001);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: (pid) => pid !== 999_001, // leader dead → orphan-reap path
        listGroup: () => {
          throw new Error("ps: command not found");
        },
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false);
    expect(signals).toEqual([]);
    // ⛔ The record MUST survive. Deleting it is what turns a probe failure
    // into a permanent orphan nothing can find again.
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
    // Actionable, not merely negative.
    expect(r.reason).toContain("999001");
    expect(r.reason).toContain("runtime.pid");
    expect(r.reason?.toLowerCase()).not.toContain("already stopped");
  });

  it("⛔ REFUSES when `ps` exits non-zero (the probe answers null, not [])", async () => {
    pidfileFor(999_001, 999_001);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: { isAlive: (pid) => pid !== 999_001, listGroup: () => null },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(signals).toEqual([]);
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("succeeds without signalling when the group is genuinely gone", async () => {
    pidfileFor(999_001, 999_001);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: { isAlive: () => false, listGroup: () => [] },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(true);
    expect(signals).toEqual([]);
    // Nothing is running, so the ownership record has served its purpose.
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });
});

// ─── PID reuse: start-time mismatch (H5) ────────────────────────────────────

describe("stopOwnedGroup — recycled leader PID (start-time mismatch)", () => {
  it("⛔ REFUSES to signal when the live pid's start time contradicts the record", async () => {
    // ⛔ THE H5 incident shape. A recycled leader PID lands on a process whose
    // cwd IS the worktree (agent session / editor / shell in wave execution),
    // so cmdline/cwd proof passes — but the live process started NOW while the
    // record says a minute ago. Verification must come back `stale`, and the
    // maySignalGroup gate must then refuse the unverifiable group.
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    started.push(proc.pid);
    writePidfile(wt, {
      pid: proc.pid,
      pgid: proc.pid,
      startedAt: Date.now() - 60_000, // 12x the ±5s tolerance
      command: "npm run dev",
      state: "ready",
    });
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: () => true,
        // The impostor leader's cwd is the worktree; the group's other live
        // member is unrelated. startTimeOf is NOT stubbed — the real
        // `ps -o etime=` sees the freshly spawned sleeper.
        cwdOf: (pid) => (pid === proc.pid ? wt : "/"),
        commandOf: () => "/usr/sbin/unrelated-daemon",
        listGroup: () => [999_888],
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(signals).toEqual([]);
    expect(r.reason?.toLowerCase()).toContain("refus");
    // The record is KEPT — it is the only evidence of what may be running.
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  }, 15_000);

  it("⛔ REFUSES — fail closed — when the start time cannot be verified at all", async () => {
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    started.push(proc.pid);
    pidfileFor(proc.pid, proc.pid);
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        cwdOf: (pid) => (pid === proc.pid ? wt : "/"),
        startTimeOf: () => null, // `ps` unavailable / unparsable
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false);
    expect(signals).toEqual([]);
    expect(r.reason).toContain("start time");
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  }, 15_000);
});

// ─── `down` ─────────────────────────────────────────────────────────────────

describe("stopOwnedGroup — the declared `down`", () => {
  it("runs `down` BEFORE signalling, bounded by graceMs", async () => {
    pidfileFor(process.pid, process.pid);
    const order: string[] = [];

    await stopOwnedGroup(wt, {
      loadConfig: loading(config({ down: "docker compose down" })),
      probes: {
        commandOf: () => `sh -c cd ${wt} && npm start`,
        startTimeOf: () => Date.now(),
      },
      runShell: async (cmd, cwd, timeoutMs) => {
        order.push(`down:${cmd}:${cwd}:${timeoutMs}`);
        return { exitCode: 0, timedOut: false };
      },
      signalFn: () => order.push("signal"),
    });

    expect(order[0]).toBe(`down:docker compose down:${wt}:100`);
    expect(order).toContain("signal");
  });

  it("still signals the group when `down` fails — a partial teardown is not a teardown", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: [number, string][] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config({ down: "false" })),
      probes: {
        commandOf: () => `sh -c cd ${wt} && npm start`,
        startTimeOf: () => Date.now(),
      },
      runShell: async () => ({ exitCode: 1, timedOut: false }),
      signalFn: (t, s) => signals.push([t, s as string]),
    });

    expect(signals.length).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toContain("down");
  });
});

// ─── Re-verification after `down` (M4a) ─────────────────────────────────────

describe("stopOwnedGroup — re-verifies ownership AFTER `down` (TOCTOU)", () => {
  it("⛔ REFUSES to signal when the verdict flips during `down`", async () => {
    // The verdict used to be captured BEFORE `down` ran; `down` is bounded
    // only by graceMs, long enough for the leader to die and its PID to be
    // recycled — after which the stale verdict authorised `kill -- -pgid`
    // against a stranger's group.
    pidfileFor(999_100, 999_100);
    const signals: unknown[] = [];
    let phase: "before" | "after" = "before";

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config({ down: "docker compose down" })),
      probes: {
        isAlive: () => true,
        commandOf: () =>
          phase === "before" ? `node server.js ${wt}` : "/usr/sbin/cupsd -l",
        cwdOf: () => (phase === "before" ? wt : "/"),
        startTimeOf: () => Date.now(),
      },
      runShell: async () => {
        // The world changes while `down` runs: the leader dies and the PID
        // lands on an unrelated process.
        phase = "after";
        return { exitCode: 0, timedOut: false };
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(signals).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false);
    expect(r.reason?.toLowerCase()).toContain("down");
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("still succeeds when `down` itself stopped the stack (leader gone, group empty)", async () => {
    // The routine success shape must NOT be refused: `down` doing its job
    // looks like the leader dying mid-`down`.
    pidfileFor(999_100, 999_100);
    let downRan = false;
    const signals: unknown[] = [];

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config({ down: "docker compose down" })),
      probes: {
        isAlive: () => !downRan,
        commandOf: () => `node server.js ${wt}`,
        startTimeOf: () => Date.now(),
        listGroup: () => (downRan ? [] : [999_100]),
      },
      runShell: async () => {
        downRan = true;
        return { exitCode: 0, timedOut: false };
      },
      signalFn: (t, s) => signals.push([t, s]),
    });

    expect(r.ok).toBe(true);
    expect(signals).toEqual([]);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });
});

// ─── Honest SIGKILL failures (M4b) ──────────────────────────────────────────

describe("stopOwnedGroup — a failed SIGKILL is a FAILURE, not a warning", () => {
  it("⛔ keeps the pidfile and returns ok:false when SIGKILL fails with EPERM", async () => {
    // Reachable in production: a root-owned process cwd'd in the worktree.
    // The old code converted the exception to a warning, deleted the pidfile
    // and reported ok:true, stopped:true — orphaning a LIVE group.
    pidfileFor(999_200, 999_200);

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: () => true, // never dies
        commandOf: () => `node server.js ${wt}`,
        startTimeOf: () => Date.now(),
      },
      signalFn: (t, s) => {
        if (s === "SIGKILL") {
          const err = new Error("kill EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      },
      sleep: async () => {},
    });

    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false);
    expect(r.reason?.toLowerCase()).toContain("sigkill");
    // ⛔ Never delete a record while the group may live.
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("⛔ keeps the pidfile and returns ok:false when the group SURVIVES SIGKILL", async () => {
    pidfileFor(999_200, 999_200);

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: () => true, // survives even SIGKILL (e.g. uninterruptible)
        commandOf: () => `node server.js ${wt}`,
        startTimeOf: () => Date.now(),
      },
      signalFn: () => {},
      sleep: async () => {},
    });

    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false);
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("treats ESRCH on SIGKILL as the group being gone — a success", async () => {
    pidfileFor(999_200, 999_200);
    let killed = false;

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        isAlive: () => !killed,
        commandOf: () => `node server.js ${wt}`,
        startTimeOf: () => Date.now(),
      },
      signalFn: (t, s) => {
        if (s === "SIGKILL") {
          killed = true;
          const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
      sleep: async () => {},
    });

    expect(r.ok).toBe(true);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });
});

// ─── Windows degradation ────────────────────────────────────────────────────

describe("stopOwnedGroup — no process group (Windows)", () => {
  it("degrades to the declared `down` and SAYS so", async () => {
    pidfileFor(process.pid, null);
    const ran: string[] = [];

    const r = await stopOwnedGroup(wt, {
      platform: "win32",
      loadConfig: loading(config({ down: "docker compose down" })),
      probes: {
        commandOf: () => `node ${wt}\\server.js`,
        startTimeOf: () => Date.now(),
      },
      runShell: async (cmd) => {
        ran.push(cmd);
        return { exitCode: 0, timedOut: false };
      },
      signalFn: () => {
        throw new Error("there is no group to signal");
      },
    });

    expect(r.ok).toBe(true);
    expect(ran).toEqual(["docker compose down"]);
    expect(r.actions.join(" ")).toContain("no process group");
  });

  it("⛔ FAILS naming the pid when there is no group AND no `down` — never a false success", async () => {
    // Schema-valid (`detached ⇒ down` does not fire for `detached: false`), and
    // on Windows there is then neither a group to signal nor a command to run.
    // Reporting success here would tell the user a process was stopped when it
    // is still running.
    pidfileFor(process.pid, null);

    const r = await stopOwnedGroup(wt, {
      platform: "win32",
      loadConfig: loading(config()),
      probes: {
        commandOf: () => `node ${wt}\\server.js`,
        startTimeOf: () => Date.now(),
      },
      signalFn: () => {
        throw new Error("there is no group to signal");
      },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(process.pid));
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });
});

// ─── Signal escalation ──────────────────────────────────────────────────────

describe("stopOwnedGroup — escalation", () => {
  it("escalates to SIGKILL when the group outlives the grace period", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: [number, string][] = [];
    let killed = false;

    const r = await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        commandOf: () => `sh -c cd ${wt} && npm start`,
        isAlive: () => !killed, // survives SIGTERM, dies to SIGKILL
        startTimeOf: () => Date.now(),
      },
      signalFn: (t, s) => {
        signals.push([t, s as string]);
        if (s === "SIGKILL") killed = true;
      },
      sleep: async () => {},
    });

    expect(signals).toContainEqual([-process.pid, "SIGTERM"]);
    expect(signals).toContainEqual([-process.pid, "SIGKILL"]);
    expect(r.ok).toBe(true);
  });

  it("does NOT escalate when the group dies within the grace period", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: [number, string][] = [];
    let alive = true;

    await stopOwnedGroup(wt, {
      loadConfig: loading(config()),
      probes: {
        commandOf: () => `sh -c cd ${wt} && npm start`,
        isAlive: () => alive,
        startTimeOf: () => Date.now(),
      },
      signalFn: (t, s) => {
        signals.push([t, s as string]);
        alive = false;
      },
      sleep: async () => {},
    });

    expect(signals).toEqual([[-process.pid, "SIGTERM"]]);
  });

  it("honours a configured SIGINT instead of SIGTERM", async () => {
    pidfileFor(process.pid, process.pid);
    const signals: [number, string][] = [];
    let alive = true;

    await stopOwnedGroup(wt, {
      loadConfig: loading(
        RuntimeConfigSchema.parse({
          shutdown: { signal: "SIGINT", graceMs: 100 },
        }),
      ),
      probes: {
        commandOf: () => `sh -c cd ${wt} && npm start`,
        isAlive: () => alive,
        startTimeOf: () => Date.now(),
      },
      signalFn: (t, s) => {
        signals.push([t, s as string]);
        alive = false;
      },
      sleep: async () => {},
    });

    expect(signals).toEqual([[-process.pid, "SIGINT"]]);
  });
});

// ─── Real processes ─────────────────────────────────────────────────────────

describe("stopOwnedGroup — against real detached process groups", () => {
  it("kills THIS worktree's group while another worktree's process SURVIVES", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-other-")));
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    mkdirSync(join(other, ".sentinal"), { recursive: true });
    for (const dir of [wt, other]) {
      writeFileSync(
        join(dir, ".sentinal", "runtime.json"),
        JSON.stringify({ shutdown: { signal: "SIGTERM", graceMs: 100 } }),
      );
    }

    const mine = spawnDetached({ worktreePath: wt, command: "sleep 30" });
    const theirs = spawnDetached({ worktreePath: other, command: "sleep 30" });
    started.push(mine.pid, theirs.pid);

    writePidfile(wt, {
      pid: mine.pid,
      pgid: mine.pgid,
      startedAt: Date.now(),
      command: "sleep 30",
      state: "ready",
    });

    expect(await waitFor(() => isAlive(mine.pid))).toBe(true);

    const r = await stopOwnedGroup(wt);

    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(true);
    expect(await waitFor(() => !isAlive(mine.pid))).toBe(true);
    // ⛔ Worktree B is untouched. This is Truth #2 of the master DoD.
    expect(isAlive(theirs.pid)).toBe(true);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);

    rmSync(other, { recursive: true, force: true });
  }, 20_000);

  it("kills a CHILD of the leader too — the group, not just the pid", async () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(
      join(wt, ".sentinal", "runtime.json"),
      JSON.stringify({ shutdown: { signal: "SIGTERM", graceMs: 200 } }),
    );

    // The leader `sh` backgrounds a child and waits — the classic
    // `npm run dev` shape, where killing only the leader orphans the server.
    const r = spawnDetached({
      worktreePath: wt,
      command: "sleep 30 & echo $! > child.pid; wait",
    });
    started.push(r.pid);

    expect(await waitFor(() => existsSync(join(wt, "child.pid")))).toBe(true);
    const childPid = Number(
      require("node:fs").readFileSync(join(wt, "child.pid"), "utf-8").trim(),
    );
    started.push(childPid);

    writePidfile(wt, {
      pid: r.pid,
      pgid: r.pgid,
      startedAt: Date.now(),
      command: "sleep 30 &",
      state: "ready",
    });

    await stopOwnedGroup(wt);

    expect(await waitFor(() => !isAlive(r.pid))).toBe(true);
    expect(await waitFor(() => !isAlive(childPid))).toBe(true);
  }, 20_000);
});

// ─── assertStillAlive ───────────────────────────────────────────────────────

describe("assertStillAlive", () => {
  it("reports a group that died mid-run as a FAILURE, not a pass", async () => {
    // ⛔ "Tests green but the server died mid-run" is a false pass. Without
    // this check a run reports success against a stack that stopped answering.
    const r = spawnDetached({ worktreePath: wt, command: "sleep 30" });
    started.push(r.pid);
    writePidfile(wt, {
      pid: r.pid,
      pgid: r.pgid,
      startedAt: Date.now(),
      command: "sleep 30",
      state: "ready",
    });

    expect(assertStillAlive(wt).alive).toBe(true);

    process.kill(-r.pgid!, "SIGKILL");
    expect(await waitFor(() => !isAlive(r.pid))).toBe(true);

    const dead = assertStillAlive(wt);
    expect(dead.alive).toBe(false);
    expect(dead.reason).toContain(String(r.pid));
  }, 20_000);

  it("reports a foreign (PID-recycled) process as NOT alive-and-ours", () => {
    pidfileFor(process.pid, process.pid);
    const v = assertStillAlive(wt, {
      commandOf: () => "/usr/sbin/cupsd -l",
      cwdOf: () => "/",
    });
    expect(v.alive).toBe(false);
  });

  it("does NOT fail a project that never started anything", () => {
    // The backward-compatibility guarantee: no runtime contract, no pidfile,
    // nothing changes — least of all a run being reported as failed.
    const v = assertStillAlive(wt);
    expect(v.alive).toBe(true);
    expect(v.reason).toContain("runtime.pid");
  });
});
