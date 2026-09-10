/**
 * The worktree pidfile — D5's entire substitute for a process supervisor.
 *
 * Two properties carry the whole design and are asserted hardest here:
 *   1. it is written on SPAWN with `state="starting"`, never only on success —
 *      otherwise the 60s startup window has a detached group and no ownership
 *      record, and the next `runtime_up` wedges on "port occupied, no pidfile";
 *   2. every read re-derives liveness and ownership, so there is no sweep and
 *      no possibility of acting on a stale record.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runtimePidfilePath,
  writePidfile,
  readPidfile,
  markPidfileReady,
  removePidfile,
  inspectPidfile,
  ownsLiveRuntime,
  type RuntimePidfile,
} from "./pidfile.js";
import {
  RUNTIME_PIDFILE_RELATIVE_PATH,
  RUNTIME_LOG_RELATIVE_PATH,
} from "./schema.js";

let wt: string;
const spawned: { kill(): void }[] = [];

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# t\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
}

/** Fresh temp worktree per test — a leftover `state=starting` file cascades. */
beforeEach(() => {
  wt = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-pidfile-")));
});

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill();
    } catch {
      /* gone */
    }
  }
  rmSync(wt, { recursive: true, force: true });
});

const entry = (over: Partial<RuntimePidfile> = {}): RuntimePidfile => ({
  pid: process.pid,
  pgid: process.pid,
  startedAt: Date.now(),
  command: "npm run dev",
  state: "starting",
  ...over,
});

describe("constants", () => {
  it("puts the pidfile beside the log and the seeded env file", () => {
    expect(RUNTIME_PIDFILE_RELATIVE_PATH).toBe(".sentinal/runtime.pid");
  });
});

describe("write / read round-trip", () => {
  it("round-trips pid, pgid, command and state", () => {
    writePidfile(wt, entry({ pid: 4242, pgid: 4242 }));
    const back = readPidfile(wt);
    expect(back).not.toBeNull();
    expect(back!.pid).toBe(4242);
    expect(back!.pgid).toBe(4242);
    expect(back!.command).toBe("npm run dev");
    expect(back!.state).toBe("starting");
  });

  it("round-trips a NULL pgid — the Windows shape, modelled not faked", () => {
    writePidfile(wt, entry({ pid: 7, pgid: null }));
    expect(readPidfile(wt)!.pgid).toBeNull();
  });

  it("writes to <worktree>/.sentinal/runtime.pid", () => {
    writePidfile(wt, entry());
    expect(runtimePidfilePath(wt)).toBe(join(wt, ".sentinal", "runtime.pid"));
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("creates .sentinal/ when it does not exist yet", () => {
    expect(existsSync(join(wt, ".sentinal"))).toBe(false);
    const r = writePidfile(wt, entry());
    expect(r.written).toBe(true);
  });

  it("returns null for an absent file", () => {
    expect(readPidfile(wt)).toBeNull();
  });

  it("returns null for a corrupt file rather than throwing", () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(runtimePidfilePath(wt), "{not json");
    expect(readPidfile(wt)).toBeNull();
  });

  it("returns null for a structurally wrong file rather than throwing", () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(runtimePidfilePath(wt), JSON.stringify({ pid: "nope" }));
    expect(readPidfile(wt)).toBeNull();
  });
});

describe("markPidfileReady", () => {
  it("flips state in place, preserving pid/pgid", () => {
    writePidfile(wt, entry({ pid: 99, pgid: 99 }));
    expect(markPidfileReady(wt, 99).ok).toBe(true);

    const back = readPidfile(wt)!;
    expect(back.state).toBe("ready");
    expect(back.pid).toBe(99);
    expect(back.pgid).toBe(99);
  });

  it("REFUSES when a different pid now owns the file", () => {
    writePidfile(wt, entry({ pid: 99 }));
    const r = markPidfileReady(wt, 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("99");
    expect(readPidfile(wt)!.state).toBe("starting");
  });

  it("REFUSES when the file has vanished", () => {
    expect(markPidfileReady(wt, 99).ok).toBe(false);
  });
});

describe("removePidfile", () => {
  it("removes the file", () => {
    writePidfile(wt, entry({ pid: 5 }));
    expect(removePidfile(wt).removed).toBe(true);
    expect(existsSync(runtimePidfilePath(wt))).toBe(false);
  });

  it("is idempotent — removing a file that is not there is a success", () => {
    expect(removePidfile(wt).removed).toBe(true);
    expect(removePidfile(wt).removed).toBe(true);
  });

  it("REFUSES to delete a file another pid has since claimed", () => {
    writePidfile(wt, entry({ pid: 5 }));
    const r = removePidfile(wt, 6);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("5");
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });

  it("deletes when the expected pid still owns it", () => {
    writePidfile(wt, entry({ pid: 5 }));
    expect(removePidfile(wt, 5).removed).toBe(true);
  });
});

describe("inspectPidfile", () => {
  it("reports absent when there is no file", () => {
    expect(inspectPidfile(wt).kind).toBe("absent");
  });

  it("reports unreadable for a corrupt file, naming the path", () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(runtimePidfilePath(wt), "garbage");
    const v = inspectPidfile(wt);
    expect(v.kind).toBe("unreadable");
  });

  it("reports STALE when the recorded leader is dead", () => {
    writePidfile(wt, entry({ pid: 0x7ffffff0, pgid: 0x7ffffff0 }));
    const v = inspectPidfile(wt);
    expect(v.kind).toBe("stale");
  });

  it("reports FOREIGN for a live pid whose cmdline does not reference the worktree", () => {
    // This process is alive but its cwd/cmdline belong to the repo, not `wt`.
    writePidfile(wt, entry({ pid: process.pid, pgid: process.pid }));
    const v = inspectPidfile(wt);
    expect(v.kind).toBe("foreign");
  });

  it("reports FOREIGN when ownership cannot be verified — never 'owned'", () => {
    writePidfile(wt, entry({ pid: process.pid }));
    const v = inspectPidfile(wt, {
      commandOf: () => null,
      cwdOf: () => null,
    });
    expect(v.kind).toBe("foreign");
  });

  it("reports OWNED for a live process whose cwd is the worktree", () => {
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);
    writePidfile(wt, entry({ pid: proc.pid, pgid: proc.pid, state: "ready" }));

    const v = inspectPidfile(wt);
    expect(v.kind).toBe("owned");
    if (v.kind === "owned") expect(v.entry.state).toBe("ready");
  });
});

describe("inspectPidfile — start-time verification (H5)", () => {
  /**
   * ⛔ THE recycled-PID case this task exists for. The process is ALIVE and
   * its cwd IS the worktree — in wave execution the agent session, the user's
   * editor and their shell all look exactly like this — so command-line/cwd
   * proof passes. Only the recorded start time can tell the impostor apart.
   */
  it("⛔ reports STALE for a live worktree-cwd process whose start time mismatches", () => {
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);
    // Forged: the record claims the leader started a minute ago; the live
    // process wearing that PID started just now. 60s is 12x the tolerance.
    writePidfile(
      wt,
      entry({
        pid: proc.pid,
        pgid: proc.pid,
        startedAt: Date.now() - 60_000,
        state: "ready",
      }),
    );

    const v = inspectPidfile(wt);
    expect(v.kind).toBe("stale");
    if (v.kind === "stale") {
      expect(v.reason.toUpperCase()).toContain("RECYCLED");
    }
  }, 15_000);

  it("still reports OWNED when the recorded start time matches (real `ps`)", () => {
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);
    writePidfile(wt, entry({ pid: proc.pid, pgid: proc.pid }));
    expect(inspectPidfile(wt).kind).toBe("owned");
  }, 15_000);

  it("skips the comparison for a legacy record (startedAt 0) — today's behaviour", () => {
    // A record written before this check existed must not orphan (or refuse)
    // a running stack after an upgrade.
    const proc = Bun.spawn(["sleep", "30"], {
      cwd: wt,
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(proc);
    writePidfile(wt, entry({ pid: proc.pid, pgid: proc.pid, startedAt: 0 }));
    expect(inspectPidfile(wt).kind).toBe("owned");
  }, 15_000);

  it("⛔ reports FOREIGN — refuse, keep the pidfile — when `ps` cannot answer", () => {
    writePidfile(wt, entry({ pid: process.pid, pgid: process.pid }));
    const v = inspectPidfile(wt, {
      commandOf: () => `node server.js ${wt}`,
      startTimeOf: () => null,
    });
    expect(v.kind).toBe("foreign");
    if (v.kind === "foreign") {
      expect(v.reason).toContain("start time");
      expect(v.reason).toContain("runtime.pid");
    }
    // The record survives — the whole point of refusing on uncertainty.
    expect(existsSync(runtimePidfilePath(wt))).toBe(true);
  });
});

describe("git invisibility", () => {
  it("hides both the pidfile and the logfile from git status", () => {
    initRepo(wt);
    const r = writePidfile(wt, entry());
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(join(wt, RUNTIME_LOG_RELATIVE_PATH), "log line\n");

    const status = String(
      Bun.spawnSync(["git", "status", "--porcelain"], { cwd: wt }).stdout,
    );
    expect(status).not.toContain("runtime.pid");
    expect(status).not.toContain("runtime.log");
    expect(r.warnings).toEqual([]);
  });

  it("SURFACES tier-3 warnings instead of swallowing them", () => {
    initRepo(wt);
    // Track .sentinal/.gitignore so git-exclude refuses to dirty it (tier 3).
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(join(wt, ".sentinal", ".gitignore"), "# tracked\n");
    Bun.spawnSync(["git", "add", "-f", ".sentinal/.gitignore"], { cwd: wt });
    Bun.spawnSync(["git", "commit", "-m", "track ignore"], { cwd: wt });

    const r = writePidfile(wt, entry());
    expect(r.written).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join("\n")).toContain("runtime.pid");
  });

  it("still writes the pidfile when it could not be hidden", () => {
    // Hiding is best-effort; losing the ownership record is not acceptable.
    const r = writePidfile(wt, entry()); // not a git repo at all
    expect(r.written).toBe(true);
    expect(readFileSync(runtimePidfilePath(wt), "utf-8")).toContain('"pid"');
  });
});

describe("ownsLiveRuntime", () => {
  /**
   * ⛔ This feeds `worktree_cleanup --force`'s guard 5, which decides whether
   * to DELETE a directory. It is therefore deliberately **conservative in the
   * opposite direction** to {@link inspectPidfile}: anything it cannot rule out
   * counts as live, because the cost of a false "nothing running" is a live
   * process whose working directory has just been deleted, and the cost of a
   * false "something running" is one skipped cleanup and a warning.
   */
  it("is not live when there is no pidfile — the fast, common case", () => {
    expect(ownsLiveRuntime(wt).live).toBe(false);
  });

  it("is live for a running, provably-owned process", () => {
    writePidfile(wt, entry({ pid: process.pid, pgid: process.pid }));
    const v = ownsLiveRuntime(wt, {
      commandOf: () => `node server.js ${wt}`,
      // `process.pid` started when `bun test` did, not when the record was
      // written — stub the H5 probe so this stays the owned row.
      startTimeOf: () => Date.now(),
    });
    expect(v.live).toBe(true);
    expect(v.detail).toContain(String(process.pid));
  });

  it("⛔ is live for an UNREADABLE pidfile — unknown must not authorise deletion", () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(runtimePidfilePath(wt), "{ not json");
    const v = ownsLiveRuntime(wt);
    expect(v.live).toBe(true);
    expect(v.detail).toBeDefined();
  });

  it("⛔ is live for an alive-but-unprovable pid — refusing to delete beats guessing", () => {
    writePidfile(wt, entry({ pid: process.pid, pgid: process.pid }));
    const v = ownsLiveRuntime(wt, {
      commandOf: () => "/usr/sbin/cupsd -l",
      cwdOf: () => "/",
    });
    expect(v.live).toBe(true);
  });

  it("is live when the leader is dead but its GROUP still has members", () => {
    writePidfile(wt, entry({ pid: 999_001, pgid: 999_001 }));
    const v = ownsLiveRuntime(wt, {
      isAlive: (pid) => pid !== 999_001,
      listGroup: () => [999_002],
    });
    expect(v.live).toBe(true);
    expect(v.detail).toContain("999001");
  });

  it("is NOT live when the leader is dead and the group is ENUMERATED as empty", () => {
    writePidfile(wt, entry({ pid: 999_001, pgid: 999_001 }));
    const v = ownsLiveRuntime(wt, {
      isAlive: () => false,
      listGroup: () => [],
    });
    expect(v.live).toBe(false);
  });

  /**
   * ⛔ The must_fix, on the branch whose verdict authorises a **directory
   * deletion**. "We could not enumerate the group" is the one answer this
   * function must never round down to "nothing is running": the asymmetry its
   * own docstring claims ("anything it cannot rule out counts as live") held
   * for `unreadable`/`foreign`/`owned` but not for `stale`.
   */
  it("⛔ is LIVE when the leader is dead and the group cannot be ENUMERATED", () => {
    writePidfile(wt, entry({ pid: 999_001, pgid: 999_001 }));
    const v = ownsLiveRuntime(wt, {
      isAlive: () => false,
      listGroup: () => {
        throw new Error("ps: command not found");
      },
    });
    expect(v.live).toBe(true);
    expect(v.detail).toContain("999001");
    expect(v.detail).toContain("runtime.pid");
  });

  it("⛔ is LIVE when the group probe answers `null` (ps exited non-zero)", () => {
    writePidfile(wt, entry({ pid: 999_001, pgid: 999_001 }));
    const v = ownsLiveRuntime(wt, {
      isAlive: () => false,
      listGroup: () => null,
    });
    expect(v.live).toBe(true);
  });
});
