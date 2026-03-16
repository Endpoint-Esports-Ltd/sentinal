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
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import {
  readSidecarPid,
  removeSidecarPid,
  isSidecarRunning,
  getSidecarStatus,
  stopSidecarProcess,
  isSidecarReachable,
} from "./lifecycle.js";
import * as serverModule from "./server.js";

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
    // When the PID file matches the process being stopped, cleanup proceeds
    writeFileSync(pidPath, String(process.pid), "utf-8");
    writeFileSync(socketPath, "x", "utf-8");
    writeFileSync(portPath, "12345", "utf-8");

    // Intercept SIGTERM so it doesn't kill the test
    const origHandlers = process.listeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    process.once("SIGTERM", () => {
      /* swallow */
    });

    const result = stopSidecarProcess();

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
