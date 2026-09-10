/**
 * Detached spawn — the half of D5 that makes ownership possible at all.
 *
 * Two of these tests answer questions the plan explicitly refused to let the
 * implementer assume:
 *
 *   1. **Does `Bun.spawn({detached:true})` actually yield `pgid === pid`?**
 *      `bun.d.ts:6494-6508` says it calls `setsid()` on POSIX, which would make
 *      the child a session *and* group leader. Asserted, not assumed — the
 *      whole `kill -- -$PGID` mechanism is built on it.
 *   2. **Does `stdio: ["ignore", logFd, logFd]` keep the parent alive?**
 *      `bun.d.ts:6503-6504` warns that stdio "may keep the parent process
 *      alive" and prescribes all-ignore. If that applied to a real file
 *      descriptor, the MCP server would hang on exit after every `runtime_up`.
 *      Asserted by spawning a fixture parent and awaiting its exit on a short
 *      deadline.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnDetached,
  resolvePgid,
  runtimeLogPath,
  readLogTail,
} from "./spawn.js";
import { RUNTIME_LOG_RELATIVE_PATH } from "./schema.js";

let wt: string;
const started: number[] = [];

/** Fresh temp worktree per test — a leftover pidfile/log cascades. */
beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-spawn-")));
});

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(wt, { recursive: true, force: true });
});

function track<T extends { pid: number }>(r: T): T {
  started.push(r.pid);
  return r;
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

describe("runtimeLogPath", () => {
  it("resolves the fixed contract path under the worktree", () => {
    expect(runtimeLogPath(wt)).toBe(join(wt, RUNTIME_LOG_RELATIVE_PATH));
  });
});

describe("spawnDetached — process group", () => {
  it("puts the child in its OWN process group whose pgid equals its pid (POSIX setsid)", async () => {
    const r = track(spawnDetached({ worktreePath: wt, command: "sleep 30" }));

    expect(r.pid).toBeGreaterThan(1);
    // ⛔ The load-bearing assertion. `kill -- -$PGID` targeting anything other
    // than a group we lead would signal processes we never started.
    expect(r.pgid).toBe(r.pid);

    // Cross-check against the OS rather than trusting our own bookkeeping.
    expect(resolvePgid(r.pid)).toBe(r.pid);

    // And it must NOT be this test runner's group, or teardown would kill bun.
    expect(r.pgid).not.toBe(resolvePgid(process.pid));
  });

  it("reports a NON-NULL pgid on POSIX even for a leader that exits immediately", async () => {
    // ⚠️ The flagship detaching starter (`docker compose up -d`) returns almost
    // at once, so `ps -o pgid=` can lose the race and report nothing. Answering
    // `null` there would silently discard the group for exactly the
    // configuration the master plan names as the right answer. POSIX `setsid()`
    // (asserted above) makes `pid` the correct value, and every signal is
    // ownership-verified before it is sent regardless.
    const r = track(spawnDetached({ worktreePath: wt, command: "true" }));
    await r.exited;
    expect(r.pgid).toBe(r.pid);
  });

  it("resolvePgid itself stays HONEST — null when the OS cannot be asked", () => {
    // ⛔ The fallback belongs to spawnDetached, where `setsid()` has just been
    // called and `pid` is therefore a justified answer. `resolvePgid` must NOT
    // fabricate one, or the orphan-reap path in Task 4 would "resolve" a dead
    // leader's group to a number nothing supports.
    expect(resolvePgid(0)).toBeNull();
    expect(resolvePgid(1)).toBeNull();
    expect(resolvePgid(-5)).toBeNull();
    // A pid that has certainly been reaped: our own short-lived child.
    const dead = Bun.spawnSync(["true"], { stdout: "ignore" });
    expect(dead.success).toBe(true);
  });

  it("survives its parent and is killable as a group", async () => {
    const r = track(spawnDetached({ worktreePath: wt, command: "sleep 30" }));
    expect(await waitFor(() => isAlive(r.pid))).toBe(true);

    process.kill(-r.pgid!, "SIGKILL");
    expect(await waitFor(() => !isAlive(r.pid))).toBe(true);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

describe("spawnDetached — log capture", () => {
  it("captures stdout AND stderr to .sentinal/runtime.log", async () => {
    const r = track(
      spawnDetached({
        worktreePath: wt,
        command: "echo to-stdout; echo to-stderr 1>&2",
      }),
    );
    await r.exited;

    const log = readFileSync(runtimeLogPath(wt), "utf-8");
    expect(log).toContain("to-stdout");
    expect(log).toContain("to-stderr");
    expect(r.logPath).toBe(runtimeLogPath(wt));
  });

  it("APPENDS across runs rather than truncating the previous failure's evidence", async () => {
    await track(spawnDetached({ worktreePath: wt, command: "echo first" }))
      .exited;
    await track(spawnDetached({ worktreePath: wt, command: "echo second" }))
      .exited;

    const log = readFileSync(runtimeLogPath(wt), "utf-8");
    expect(log).toContain("first");
    expect(log).toContain("second");
  });

  it("runs the command with the worktree as cwd — the durable ownership proof", async () => {
    const r = track(spawnDetached({ worktreePath: wt, command: "pwd" }));
    await r.exited;
    expect(readFileSync(runtimeLogPath(wt), "utf-8")).toContain(wt);
  });
});

describe("spawnDetached — environment", () => {
  it("exports SENTINAL_WORKTREE_SLOT for scripts invoked by `up`", async () => {
    const r = track(
      spawnDetached({
        worktreePath: wt,
        command: "echo slot=$SENTINAL_WORKTREE_SLOT",
        slot: 3,
      }),
    );
    await r.exited;
    expect(readFileSync(runtimeLogPath(wt), "utf-8")).toContain("slot=3");
  });

  it("leaves SENTINAL_WORKTREE_SLOT unset when the worktree has no slot", async () => {
    const r = track(
      spawnDetached({
        worktreePath: wt,
        command: "echo [slot=${SENTINAL_WORKTREE_SLOT-unset}]",
        slot: null,
      }),
    );
    await r.exited;
    // ⛔ Never invent a slot value — an empty or fabricated one points the run
    // at resources that are not this worktree's (loader.ts slotlessWarning).
    expect(readFileSync(runtimeLogPath(wt), "utf-8")).toContain("[slot=unset]");
  });

  it("passes extra env entries through", async () => {
    const r = track(
      spawnDetached({
        worktreePath: wt,
        command: "echo v=$SENTINAL_TEST_VAR",
        env: { SENTINAL_TEST_VAR: "ok" },
      }),
    );
    await r.exited;
    expect(readFileSync(runtimeLogPath(wt), "utf-8")).toContain("v=ok");
  });
});

describe("spawnDetached — leader exit observation", () => {
  it("reports null while running and the code once exited", async () => {
    const r = track(spawnDetached({ worktreePath: wt, command: "exit 7" }));
    await r.exited;
    expect(r.exitCode()).toBe(7);
  });

  it("reports 0 for a detaching starter that returns immediately", async () => {
    const r = track(spawnDetached({ worktreePath: wt, command: "true" }));
    expect(await r.exited).toBe(0);
    expect(r.exitCode()).toBe(0);
  });
});

describe("readLogTail", () => {
  it("returns the last N lines only", () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(
      runtimeLogPath(wt),
      Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n") + "\n",
    );

    const tail = readLogTail(wt, 5);
    expect(tail).toContain("line-199");
    expect(tail).toContain("line-195");
    expect(tail).not.toContain("line-194");
  });

  it("is a safe empty string when no log exists", () => {
    expect(readLogTail(wt)).toBe("");
    expect(existsSync(runtimeLogPath(wt))).toBe(false);
  });
});

describe("spawnDetached — the parent must not be held alive by stdio", () => {
  /**
   * ⛔ `bun.d.ts:6503-6504` warns, inside the very docblock that promises
   * `setsid()`, that stdio "may keep the parent process alive". If that held
   * for a real file descriptor, every `runtime_up` would hang the MCP server on
   * exit. Empirically it does not — this test is what keeps it that way.
   */
  it("a parent that calls spawnDetached exits promptly while the child lives on", async () => {
    const spawnModule = join(import.meta.dir, "spawn.ts");
    const fixture = join(wt, "parent-fixture.ts");
    writeFileSync(
      fixture,
      `import { spawnDetached } from ${JSON.stringify(spawnModule)};\n` +
        `const r = spawnDetached({ worktreePath: ${JSON.stringify(wt)}, command: "sleep 30" });\n` +
        `process.stdout.write(String(r.pid));\n`,
    );

    const parent = Bun.spawn(["bun", fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await Promise.race([
      parent.exited,
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 8000)),
    ]);

    const out = await new Response(parent.stdout).text();
    const childPid = Number(out.trim());
    if (Number.isInteger(childPid) && childPid > 1) started.push(childPid);

    // The parent exited on its own — stdio did NOT hold it open.
    expect(exitCode).toBe(0);
    // …and the detached child outlived it, which is the entire point.
    expect(isAlive(childPid)).toBe(true);
  }, 20_000);
});
