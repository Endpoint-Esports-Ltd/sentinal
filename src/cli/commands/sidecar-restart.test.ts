import { describe, it, expect } from "bun:test";
import {
  runRestart,
  waitForProcessExit,
  spawnDetachedSidecar,
  buildSpawnCmd,
  type RestartDeps,
} from "./sidecar-restart.js";

/** Build a full set of fakes that record the order of calls. */
function makeDeps(overrides: Partial<RestartDeps> = {}): {
  deps: RestartDeps;
  calls: string[];
  lines: string[];
} {
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: RestartDeps = {
    readPid: () => {
      calls.push("readPid");
      return 111;
    },
    stop: () => {
      calls.push("stop");
      return true;
    },
    waitForExit: async (pid, timeoutMs) => {
      calls.push(`waitForExit:${pid}:${timeoutMs}`);
      return true;
    },
    spawnBackground: (opts) => {
      calls.push(`spawnBackground:${opts.httpOnly ? "http" : "default"}`);
      return 222;
    },
    waitForReady: async () => {
      calls.push("waitForReady");
      return true;
    },
    startForeground: async (opts) => {
      calls.push(`startForeground:${opts.httpOnly ? "http" : "default"}`);
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, calls, lines };
}

describe("runRestart", () => {
  it("defaults to background: stops, waits for the old PID, spawns, returns 0", async () => {
    const { deps, calls, lines } = makeDeps();
    const code = await runRestart({}, deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "readPid",
      "stop",
      "waitForExit:111:10000",
      "spawnBackground:default",
      "waitForReady",
    ]);
    expect(calls).not.toContain("startForeground:default");
    expect(lines.join("\n")).toContain("PID: 222");
  });

  it("waits for the old PID to exit BEFORE spawning the new sidecar", async () => {
    let oldAlive = true;
    let spawnedWhileOldAlive = null as boolean | null;
    const { deps } = makeDeps({
      waitForExit: async () => {
        await new Promise((r) => setTimeout(r, 5));
        oldAlive = false;
        return true;
      },
      spawnBackground: () => {
        spawnedWhileOldAlive = oldAlive;
        return 222;
      },
    });
    await runRestart({}, deps);
    expect(spawnedWhileOldAlive).toBe(false);
  });

  it("honours a custom exit timeout", async () => {
    const { deps, calls } = makeDeps();
    await runRestart({ exitTimeoutMs: 1234 }, deps);
    expect(calls).toContain("waitForExit:111:1234");
  });

  it("refuses to start (exit 1) when the old sidecar does not exit in time", async () => {
    const { deps, calls, lines } = makeDeps({
      waitForExit: async () => false,
    });
    const code = await runRestart({}, deps);
    expect(code).toBe(1);
    expect(calls.some((c) => c.startsWith("spawnBackground"))).toBe(false);
    expect(calls.some((c) => c.startsWith("startForeground"))).toBe(false);
    expect(lines.join("\n")).toContain("111");
  });

  it("does not wait when nothing was stopped", async () => {
    const { deps, calls } = makeDeps({ stop: () => false });
    const code = await runRestart({}, deps);
    expect(code).toBe(0);
    expect(calls.some((c) => c.startsWith("waitForExit"))).toBe(false);
    expect(calls).toContain("spawnBackground:default");
  });

  it("does not wait when there was no PID file", async () => {
    const { deps, calls } = makeDeps({ readPid: () => null });
    await runRestart({}, deps);
    expect(calls.some((c) => c.startsWith("waitForExit"))).toBe(false);
  });

  it("--foreground runs the foreground start path and never spawns", async () => {
    const { deps, calls } = makeDeps();
    const code = await runRestart({ foreground: true, httpOnly: true }, deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "readPid",
      "stop",
      "waitForExit:111:10000",
      "startForeground:http",
    ]);
  });

  it("passes --http-only through to the background spawn", async () => {
    const { deps, calls } = makeDeps();
    await runRestart({ httpOnly: true }, deps);
    expect(calls).toContain("spawnBackground:http");
  });

  it("returns 1 when the background sidecar never becomes reachable", async () => {
    const { deps, lines } = makeDeps({ waitForReady: async () => false });
    const code = await runRestart({}, deps);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/not reachable/i);
  });

  it("returns 1 when the spawn fails", async () => {
    const { deps, calls } = makeDeps({
      spawnBackground: () => {
        throw new Error("ENOENT");
      },
    });
    const code = await runRestart({}, deps);
    expect(code).toBe(1);
    expect(calls).not.toContain("waitForReady");
  });
});

describe("waitForProcessExit", () => {
  it("resolves true as soon as the process is gone", async () => {
    let checks = 0;
    const ok = await waitForProcessExit(42, 1000, {
      isAlive: () => ++checks < 3,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    });
    expect(ok).toBe(true);
    expect(checks).toBe(3);
  });

  it("resolves false once the timeout elapses with the process still alive", async () => {
    let t = 0;
    const ok = await waitForProcessExit(42, 100, {
      isAlive: () => true,
      // Yield a real macrotask so a missing deadline fails via the test
      // timeout instead of spinning the microtask queue forever.
      sleep: async (ms) => {
        t += ms;
        await new Promise((r) => setTimeout(r, 0));
      },
      now: () => t,
    });
    expect(ok).toBe(false);
    expect(t).toBeGreaterThanOrEqual(100);
  }, 1000);
});

describe("spawnDetachedSidecar", () => {
  it("spawns detached with ignored stdio and unrefs the child", () => {
    let seenCmd: string[] = [];
    let seenOpts: Record<string, unknown> = {};
    let unrefed = false;
    const pid = spawnDetachedSidecar(["sidecar", "start"], (cmd, opts) => {
      seenCmd = cmd;
      seenOpts = opts as Record<string, unknown>;
      return {
        pid: 777,
        unref: () => {
          unrefed = true;
        },
      };
    });
    expect(pid).toBe(777);
    expect(seenOpts.detached).toBe(true);
    expect(seenOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(unrefed).toBe(true);
    expect(seenCmd.slice(-2)).toEqual(["sidecar", "start"]);
  });
});

describe("buildSpawnCmd", () => {
  it("uses execPath for compiled binaries", () => {
    expect(buildSpawnCmd(["x"], "/$bunfs/root/sentinal", "/usr/bin/s")).toEqual(
      ["/usr/bin/s", "x"],
    );
  });

  it("prefixes bun in source mode", () => {
    expect(buildSpawnCmd(["x"], "/repo/src/cli/index.ts", "/b/bun")).toEqual([
      "bun",
      "/repo/src/cli/index.ts",
      "x",
    ]);
  });
});
