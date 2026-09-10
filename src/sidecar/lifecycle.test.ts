/**
 * Sidecar Lifecycle Tests
 *
 * Tests PID management, status detection, and cleanup logic.
 * Uses mocked PID/socket paths to avoid affecting the real sidecar.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { join } from "node:path";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import {
  readSidecarPid,
  removeSidecarPid,
  isSidecarRunning,
  getSidecarStatus,
  stopSidecarProcess,
  isSidecarReachable,
  assessSidecarStart,
  autoStartSidecarAsync,
  probeProcessCommand,
  looksLikeSidecarArgv,
  getSidecarStartLockPath,
} from "./lifecycle.js";
import * as serverModule from "./server.js";
import * as pathsModule from "./paths.js";

describe("sidecar lifecycle", () => {
  let tmpDir: string;
  let pidPath: string;
  let socketPath: string;
  let portPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    pidPath = join(tmpDir, "sidecar.pid");
    socketPath = join(tmpDir, "sidecar.sock");
    portPath = join(tmpDir, "sidecar.port");

    // Mock the path getters to point at our tmp dir
    spyOn(serverModule, "getSidecarPidPath").mockReturnValue(pidPath);
    spyOn(serverModule, "getSidecarSocketPath").mockReturnValue(socketPath);
    spyOn(serverModule, "getSidecarPortPath").mockReturnValue(portPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // ─── PID helpers ────────────────────────────────────────────────────────

  it("should return null when no PID file", () => {
    expect(readSidecarPid()).toBeNull();
  });

  it("should read a valid PID file", () => {
    writeFileSync(pidPath, "12345", "utf-8");
    expect(readSidecarPid()).toBe(12345);
  });

  it("should return null for invalid PID content", () => {
    writeFileSync(pidPath, "not-a-number", "utf-8");
    expect(readSidecarPid()).toBeNull();
  });

  it("should remove PID file", () => {
    writeFileSync(pidPath, "12345", "utf-8");
    removeSidecarPid();
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should not throw when removing non-existent PID", () => {
    expect(() => removeSidecarPid()).not.toThrow();
  });

  // ─── isSidecarRunning ──────────────────────────────────────────────────

  it("should return false when no PID file", () => {
    expect(isSidecarRunning()).toBe(false);
  });

  it("should return true when current process PID is in file", () => {
    writeFileSync(pidPath, String(process.pid), "utf-8");
    expect(isSidecarRunning()).toBe(true);
  });

  it("should clean up stale PID and return false", () => {
    // Use a PID that almost certainly doesn't exist
    writeFileSync(pidPath, "999999999", "utf-8");
    expect(isSidecarRunning()).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  // ─── getSidecarStatus ─────────────────────────────────────────────────

  it("should return not running when no PID", () => {
    const status = getSidecarStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.transport).toBeNull();
  });

  it("should detect running process with unix transport", () => {
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(portPath, "unix", "utf-8");

    const status = getSidecarStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.transport).toBe("unix");
  });

  it("should detect running process with http transport", () => {
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(portPath, "41799", "utf-8");

    const status = getSidecarStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.transport).toBe("http");
  });

  // ─── stopSidecarProcess ───────────────────────────────────────────────

  it("should return false when not running", () => {
    expect(stopSidecarProcess()).toBe(false);
  });

  it("should clean up stale PID and return false", () => {
    writeFileSync(pidPath, "999999999", "utf-8");
    writeFileSync(socketPath, "x", "utf-8");
    writeFileSync(portPath, "unix", "utf-8");

    expect(stopSidecarProcess()).toBe(false);
    // All files should be cleaned up
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(portPath)).toBe(false);
  });

  // ─── Cleanup Race Regression ────────────────────────────────────────────

  it("should clean up files in stopSidecarProcess when PID matches", () => {
    // When the PID file matches the process being stopped, cleanup proceeds.
    // Identity is injected: the test process's argv is "bun test ...", which
    // rightly does NOT look like a sidecar (M2b).
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(socketPath, "x", "utf-8");
    writeFileSync(portPath, "12345", "utf-8");

    // Intercept SIGTERM so it doesn't kill the test
    const origHandlers = process.listeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    process.once("SIGTERM", () => {
      /* swallow */
    });

    const result = stopSidecarProcess({
      identify: () => "sentinal sidecar start",
    });

    // Restore SIGTERM handlers
    for (const h of origHandlers) process.on("SIGTERM", h as () => void);

    expect(result).toBe(true);
    // PID matched → cleanup should have deleted files
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(portPath)).toBe(false);
  });

  // ─── isSidecarReachable (async with probe) ─────────────────────────────

  it("should return false when no PID file (reachable check)", async () => {
    expect(await isSidecarReachable()).toBe(false);
  });

  it("should return false when PID is stale (reachable check)", async () => {
    writeFileSync(pidPath, "999999999", "utf-8");
    expect(await isSidecarReachable()).toBe(false);
    // Should have cleaned up the PID file
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should return false when process alive but not a sidecar", async () => {
    // Use current process PID — it's alive but not serving HTTP
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(portPath, "99999", "utf-8"); // port nothing is listening on
    expect(await isSidecarReachable()).toBe(false);
  });

  it("should return true when a real sidecar is serving", async () => {
    const { startSidecar, stopSidecar } = await import("./server.js");
    const sidecarTmpDir = makeTmpDir();
    const store = (await import("../memory/store.js")).MemoryStore;
    const testStore = new store(join(sidecarTmpDir, "test.db"));
    const result = await startSidecar({
      store: testStore,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });
    const port = (result.server as any).port;

    // Write PID + port file pointing at the real sidecar
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(portPath, String(port), "utf-8");

    expect(await isSidecarReachable()).toBe(true);

    stopSidecar(result.server, result.ctx);
    rmSync(sidecarTmpDir, { recursive: true, force: true });
  });
});

// ─── M2 — lifecycle integrity ────────────────────────────────────────────────
//
// M2a: start decisions use reachability, not kill(pid, 0) liveness.
// M2b: stop verifies process identity (ps argv) before signalling.
// M2d: concurrent starters are serialized by a wx start lock.

describe("sidecar lifecycle integrity (M2)", () => {
  let tmpDir: string;
  let pidPath: string;
  let socketPath: string;
  let portPath: string;
  const sleepers: Array<ReturnType<typeof Bun.spawn>> = [];

  function spawnSleeper(): ReturnType<typeof Bun.spawn> {
    const proc = Bun.spawn(["sleep", "30"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    sleepers.push(proc);
    return proc;
  }

  /** Backdate a file's mtime so age-based checks see it as old. */
  function backdate(path: string, ageMs: number): void {
    const old = new Date(Date.now() - ageMs);
    utimesSync(path, old, old);
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    pidPath = join(tmpDir, "sidecar.pid");
    socketPath = join(tmpDir, "sidecar.sock");
    portPath = join(tmpDir, "sidecar.port");
    spyOn(pathsModule, "getSidecarPidPath").mockReturnValue(pidPath);
    spyOn(pathsModule, "getSidecarSocketPath").mockReturnValue(socketPath);
    spyOn(pathsModule, "getSidecarPortPath").mockReturnValue(portPath);
  });

  afterEach(() => {
    for (const proc of sleepers) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    sleepers.length = 0;
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // ─── M2a: reachability decides the start (Truth 5) ─────────────────────

  it("starts despite a stale pidfile pointing at a recycled live PID", async () => {
    // A recycled PID: alive, but not a sidecar and not serving.
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");
    writeFileSync(portPath, "1", "utf-8"); // nothing listens on port 1
    backdate(pidPath, 60_000); // well past the boot grace

    let spawned = 0;
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        spawned++;
      },
      probeRetryDelayMs: 25, // keep the test fast; both attempts still fail
    });

    expect(outcome).toBe("started");
    expect(spawned).toBe(1);
    // Stale files were cleaned before the start
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it("does not stampede a sidecar that is still booting (young pidfile)", async () => {
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8"); // fresh mtime
    writeFileSync(portPath, "1", "utf-8"); // unreachable

    let spawned = 0;
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        spawned++;
      },
    });

    expect(outcome).toBe("booting");
    expect(spawned).toBe(0);
    // Booting sidecar's files are left alone
    expect(existsSync(pidPath)).toBe(true);
  }, 15_000);

  it("does not start when the sidecar is reachable", async () => {
    writeFileSync(pidPath, String(process.pid), "utf-8");

    let spawned = 0;
    const outcome = await autoStartSidecarAsync({
      reachable: async () => true,
      spawnFn: () => {
        spawned++;
      },
    });

    expect(outcome).toBe("already-running");
    expect(spawned).toBe(0);
  });

  it("treats a pidfile with no port/socket file as unreachable", async () => {
    // A pidfile alone proves nothing: a real sidecar always writes its
    // port file BEFORE the pidfile. PID-only fallback = recycled-PID trap.
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");
    expect(await isSidecarReachable()).toBe(false);
  });

  // ─── M2b: identity-checked stop ────────────────────────────────────────

  it("does NOT signal a recycled PID whose argv is not a sentinal sidecar", async () => {
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");
    writeFileSync(socketPath, "x", "utf-8");
    writeFileSync(portPath, "unix", "utf-8");

    // Real ps probe: sleeper's argv is "sleep 30" — not ours.
    const result = stopSidecarProcess();

    expect(result).toBe(false);
    // The sleeper must SURVIVE — signalling a recycled PID is the bug.
    expect(() => process.kill(sleeper.pid, 0)).not.toThrow();
    // Stale files are cleaned so the next start isn't blocked.
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(portPath)).toBe(false);
  }, 15_000);

  it("signals an ours-but-wedged sidecar whose argv matches the marker", async () => {
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");

    const result = stopSidecarProcess({
      identify: () => "/home/u/.sentinal/bin/sentinal sidecar start",
    });

    expect(result).toBe(true);
    // SIGTERM was delivered — the sleeper exits.
    await sleeper.exited;
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it("cleans stale files without signalling when ps fails (identity unknown)", () => {
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");

    const result = stopSidecarProcess({ identify: () => null });

    expect(result).toBe(false);
    expect(() => process.kill(sleeper.pid, 0)).not.toThrow();
    expect(existsSync(pidPath)).toBe(false);
  });

  it("probeProcessCommand returns argv for live PIDs, null for dead ones", () => {
    const own = probeProcessCommand(process.pid);
    expect(own).not.toBeNull();
    expect(own!.length).toBeGreaterThan(0);
    expect(probeProcessCommand(999999999)).toBeNull();
  }, 15_000);

  it("looksLikeSidecarArgv matches real spawn argvs and rejects lookalikes", () => {
    // The three real spawn shapes
    expect(
      looksLikeSidecarArgv("/Users/u/.sentinal/bin/sentinal sidecar start"),
    ).toBe(true);
    expect(
      looksLikeSidecarArgv("bun /repo/src/cli/index.ts sidecar start"),
    ).toBe(true);
    expect(looksLikeSidecarArgv("sentinal sidecar start --http-only")).toBe(
      true,
    );
    // Lookalikes that must NOT match
    expect(looksLikeSidecarArgv("sleep 30")).toBe(false);
    expect(looksLikeSidecarArgv("bun test src/sidecar/lifecycle.test.ts")).toBe(
      false,
    );
    expect(looksLikeSidecarArgv("vim docs/sidecar-start.md")).toBe(false);
  });

  // ─── M2d: wx start lock ────────────────────────────────────────────────

  it("only one concurrent starter spawns (wx start lock)", async () => {
    let spawned = 0;
    const spawnFn = () => {
      spawned++;
    };

    // No pidfile — both callers believe they must start.
    const [a, b] = await Promise.all([
      autoStartSidecarAsync({ spawnFn }),
      autoStartSidecarAsync({ spawnFn }),
    ]);

    expect(spawned).toBe(1);
    expect([a, b].sort()).toEqual(["lock-held", "started"]);
  });

  it("takes over a stale start lock (crashed starter)", async () => {
    const lockPath = getSidecarStartLockPath();
    writeFileSync(lockPath, "999999999", "utf-8");
    backdate(lockPath, 60_000); // older than the stale threshold

    let spawned = 0;
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        spawned++;
      },
    });

    expect(outcome).toBe("started");
    expect(spawned).toBe(1);
  });

  it("respects a fresh start lock held by another starter", async () => {
    const lockPath = getSidecarStartLockPath();
    writeFileSync(lockPath, "999999999", "utf-8"); // fresh mtime

    let spawned = 0;
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        spawned++;
      },
    });

    expect(outcome).toBe("lock-held");
    expect(spawned).toBe(0);
  });

  // ─── Slow-boot double-spawn windows (spec-review should_fix) ───────────

  it("re-touches the start lock while awaiting the child's pidfile — a live starter is never taken over on age alone", async () => {
    // Starter A: spawn succeeds but the child is slow — no pidfile yet.
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        /* child boots slowly: never writes its pidfile in this test */
      },
      touchIntervalMs: 20,
    });
    expect(outcome).toBe("started");

    // Simulate the lock aging past the stale threshold while A still waits.
    const lockPath = getSidecarStartLockPath();
    backdate(lockPath, 60_000);
    await Bun.sleep(100); // give A's guard a couple of re-touch intervals

    // Starter B must NOT take over the freshly-touched lock of a LIVE starter.
    let spawned = 0;
    const second = await autoStartSidecarAsync({
      spawnFn: () => {
        spawned++;
      },
    });
    expect(second).toBe("lock-held");
    expect(spawned).toBe(0);
  }, 15_000);

  it("releases the start lock once the child's pidfile appears", async () => {
    const outcome = await autoStartSidecarAsync({
      spawnFn: () => {
        /* pidfile written below, after "boot" */
      },
      touchIntervalMs: 10,
    });
    expect(outcome).toBe("started");
    expect(existsSync(getSidecarStartLockPath())).toBe(true);

    writeFileSync(pidPath, String(process.pid), "utf-8"); // the child booted
    await Bun.sleep(80);
    expect(existsSync(getSidecarStartLockPath())).toBe(false);
  }, 15_000);

  it("retries the reachability probe before declaring a live PID wedged", async () => {
    // A live sidecar whose event loop was blocked for one probe (in-process
    // embedding): first probe fails, retry answers — must NOT be cleaned.
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");
    backdate(pidPath, 60_000); // well past the boot grace

    let calls = 0;
    const decision = await assessSidecarStart({
      reachable: async () => ++calls >= 2,
      probeRetryDelayMs: 20,
    });

    expect(decision).toEqual({ action: "already-running" });
    expect(calls).toBe(2);
    expect(existsSync(pidPath)).toBe(true); // files NOT cleaned
  }, 15_000);

  it("still cleans and starts when every probe attempt fails (preservation)", async () => {
    const sleeper = spawnSleeper();
    writeFileSync(pidPath, String(sleeper.pid), "utf-8");
    backdate(pidPath, 60_000);

    let calls = 0;
    const decision = await assessSidecarStart({
      reachable: async () => {
        calls++;
        return false;
      },
      probeRetryDelayMs: 20,
    });

    expect(decision).toEqual({ action: "start", cleanedStale: true });
    expect(calls).toBe(2); // exactly one retry before the wedged verdict
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);
});
