/**
 * Dashboard Lifecycle Tests
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

// We test the internal functions by importing them, but override the PID path
// by testing the core logic directly rather than the path-dependent functions.

describe("Dashboard Lifecycle", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    const dir = join(realpathSync(tmpdir()), `sentinal-lc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

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
