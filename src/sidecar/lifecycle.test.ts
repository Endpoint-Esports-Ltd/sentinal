/**
 * Sidecar Lifecycle Tests
 *
 * Tests PID management, status detection, and cleanup logic.
 * Uses mocked PID/socket paths to avoid affecting the real sidecar.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import {
  readSidecarPid,
  removeSidecarPid,
  isSidecarRunning,
  getSidecarStatus,
  stopSidecarProcess,
} from "./lifecycle.js";
import * as serverModule from "./server.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
});
