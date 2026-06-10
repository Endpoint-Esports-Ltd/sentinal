/**
 * Dashboard Lifecycle Tests
 */

import { describe, it, expect, afterEach, beforeEach, spyOn, mock } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import * as fileLogModule from "../utils/file-log.js";
import * as lifecycleModule from "./lifecycle.js";

// We test the internal functions by importing them, but override the PID path
// by testing the core logic directly rather than the path-dependent functions.

describe("Dashboard Lifecycle", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a PID file", () => {
    tmpDir = makeTmpDir();
    const pidPath = join(tmpDir, "server.pid");

    writeFileSync(pidPath, String(process.pid), "utf-8");
    const content = readFileSync(pidPath, "utf-8").trim();
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("should detect that current process is alive", async () => {
    // Import the function
    const { isProcessAlive } = await import("./lifecycle.js");
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("should detect that a non-existent PID is not alive", async () => {
    const { isProcessAlive } = await import("./lifecycle.js");
    // Use a PID that almost certainly doesn't exist
    expect(isProcessAlive(999999)).toBe(false);
  });

  it("should handle missing PID file gracefully", async () => {
    tmpDir = makeTmpDir();
    const pidPath = join(tmpDir, "server.pid");

    // File doesn't exist
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should handle invalid PID file content", () => {
    tmpDir = makeTmpDir();
    const pidPath = join(tmpDir, "server.pid");

    writeFileSync(pidPath, "not-a-number", "utf-8");
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    expect(Number.isNaN(pid)).toBe(true);
  });

  it("should remove PID file on cleanup", () => {
    tmpDir = makeTmpDir();
    const pidPath = join(tmpDir, "server.pid");

    writeFileSync(pidPath, "12345", "utf-8");
    expect(existsSync(pidPath)).toBe(true);

    rmSync(pidPath, { force: true });
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should handle stale PID file (process not alive)", async () => {
    const { isProcessAlive } = await import("./lifecycle.js");

    tmpDir = makeTmpDir();
    const pidPath = join(tmpDir, "server.pid");

    // Write a PID that doesn't exist
    writeFileSync(pidPath, "999999", "utf-8");
    expect(isProcessAlive(999999)).toBe(false);
  });
});

// ─── Lifecycle Logging ────────────────────────────────────────────────────────

describe("Dashboard lifecycle logging", () => {
  let tmpDir: string;
  let getLogDirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    getLogDirSpy = spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    getLogDirSpy.mockRestore();
    mock.restore();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should log when stopServer sends SIGTERM to a live process", () => {
    // Redirect PID file path to tmpDir so the function reads the right file
    const pidPath = join(tmpDir, "server.pid");
    const getPidSpy = spyOn(lifecycleModule, "getPidFilePath").mockReturnValue(pidPath);
    writeFileSync(pidPath, String(process.pid), "utf-8");

    // Intercept SIGTERM so we don't kill the test process
    const killSpy = spyOn(process, "kill").mockImplementation((() => true) as any);
    try {
      lifecycleModule.stopServer();
    } finally {
      killSpy.mockRestore();
      getPidSpy.mockRestore();
    }

    const logPath = join(tmpDir, fileLogModule.DASHBOARD_LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("dashboard: stopped");
  });

  it("should log when stopServer finds no PID file", () => {
    const pidPath = join(tmpDir, "server.pid"); // doesn't exist
    const getPidSpy = spyOn(lifecycleModule, "getPidFilePath").mockReturnValue(pidPath);
    try {
      lifecycleModule.stopServer();
    } finally {
      getPidSpy.mockRestore();
    }

    const logPath = join(tmpDir, fileLogModule.DASHBOARD_LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("dashboard: stop skipped");
  });

  it("should log when autoStartDashboard skips because already running", async () => {
    // Redirect PID file to tmpDir with current PID → isServerRunning() returns true
    const pidPath = join(tmpDir, "server.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");
    const getPidSpy = spyOn(lifecycleModule, "getPidFilePath").mockReturnValue(pidPath);

    try {
      await lifecycleModule.autoStartDashboard(); // no version — should return early with a log
    } finally {
      getPidSpy.mockRestore();
    }

    const logPath = join(tmpDir, fileLogModule.DASHBOARD_LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("dashboard: already running");
  });
});

// ─── Startup Decision Helper ─────────────────────────────────────────────────

describe("decideServeStartup", () => {
  let tmpDir: string;
  let getLogDirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    getLogDirSpy = spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    getLogDirSpy.mockRestore();
    mock.restore();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return 'start' when health probe fails (not running)", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.0",
      probeFn: async () => null, // connection refused
    });
    expect(result.action).toBe("start");
  });

  it("should return 'exit' when same-version dashboard is live", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.0",
      probeFn: async () => ({ version: "1.30.0", pid: 9999 }),
    });
    expect(result.action).toBe("exit");
    if (result.action === "exit") expect(result.reason).toContain("already running");
  });

  it("should return 'takeover' when older-version dashboard is live with pid", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.0", pid: 9999 }),
    });
    expect(result.action).toBe("takeover");
    if (result.action === "takeover") expect(result.pid).toBe(9999);
  });

  it("should return 'takeover-no-pid' when health has no pid AND pid file is unavailable", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.29.1" }), // old dashboard, no pid field
      pidFileReadFn: () => null, // no pid file either
    });
    expect(result.action).toBe("takeover-no-pid");
  });

  // Pid-file fallback — regression guard for the 1.30.x→1.31.x upgrade gap:
  // pre-1.31 dashboards don't report pid in /api/health, but the pid file at
  // ~/.sentinal/server.pid is valid. Takeover must fall back to it instead of
  // bailing with "no pid available".
  it("should fall back to the pid file when health lacks pid (live pid → takeover)", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.31.3",
      probeFn: async () => ({ version: "1.30.1" }), // pre-1.31 health: no pid
      pidFileReadFn: () => 6451, // valid live pid from server.pid
    });
    expect(result.action).toBe("takeover");
    if (result.action === "takeover") expect(result.pid).toBe(6451);
  });

  it("should prefer the health pid over the pid file when both exist", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.31.3",
      probeFn: async () => ({ version: "1.31.0", pid: 1111 }),
      pidFileReadFn: () => 2222,
    });
    expect(result.action).toBe("takeover");
    if (result.action === "takeover") expect(result.pid).toBe(1111);
  });

  // waitForDashboardHealthy — regression guard for the false-success defect:
  // `serve --background` printed "Dashboard started (PID: N)" even when the
  // spawned child immediately exited 1 (e.g. takeover-no-pid). Background
  // mode must verify the dashboard actually answers /api/health at the
  // expected version before claiming success.
  describe("waitForDashboardHealthy", () => {
    it("resolves ok=true once the probe reports the expected version", async () => {
      let calls = 0;
      const result = await lifecycleModule.waitForDashboardHealthy({
        expectedVersion: "1.31.3",
        probeFn: async () => (++calls < 3 ? null : { version: "1.31.3", pid: 42 }),
        timeoutMs: 2000,
        intervalMs: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pid).toBe(42);
    });

    it("resolves ok=false on timeout when probe never matches", async () => {
      const result = await lifecycleModule.waitForDashboardHealthy({
        expectedVersion: "1.31.3",
        probeFn: async () => ({ version: "1.30.1" }), // stale version forever
        timeoutMs: 30,
        intervalMs: 5,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("1.30.1");
    });

    it("resolves ok=false immediately when shouldAbort reports child exit", async () => {
      const result = await lifecycleModule.waitForDashboardHealthy({
        expectedVersion: "1.31.3",
        probeFn: async () => null,
        shouldAbort: () => 1, // child exit code
        timeoutMs: 5000,
        intervalMs: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("exit");
    });
  });

  it("should return 'takeover-no-pid' when pid file reader throws", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.31.3",
      probeFn: async () => ({ version: "1.30.1" }),
      pidFileReadFn: () => {
        throw new Error("fs error");
      },
    });
    expect(result.action).toBe("takeover-no-pid");
  });

  it("should return 'start' when no version in health response (unknown dashboard)", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.0",
      probeFn: async () => ({}), // no version, no pid
    });
    expect(result.action).toBe("start");
  });

  it("should return 'start' when probe throws", async () => {
    const result = await lifecycleModule.decideServeStartup({
      currentVersion: "1.30.0",
      probeFn: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(result.action).toBe("start");
  });
});
