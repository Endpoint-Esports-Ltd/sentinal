/**
 * file-log tests
 *
 * Tests for the shared file logger: append, rotation, tail reader.
 * All tests use a spy on getLogDir() to redirect to a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import * as fileLogModule from "./file-log.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("file-log", () => {
  let tmpDir: string;
  let getLogDirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    getLogDirSpy = spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    getLogDirSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── logToFile — basics ───────────────────────────────────────────────────

  it("should create the log file and append a timestamped line", () => {
    fileLogModule.logToFile("test.log", "hello world");
    const logPath = join(tmpDir, "test.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readLines(logPath);
    expect(lines.length).toBe(1);
    // ISO timestamp prefix + message
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(lines[0]).toContain("hello world");
  });

  it("should create parent directories if missing", () => {
    const nestedDir = join(tmpDir, "a", "b", "c");
    getLogDirSpy.mockReturnValue(nestedDir);
    fileLogModule.logToFile("nested.log", "msg");
    expect(existsSync(join(nestedDir, "nested.log"))).toBe(true);
  });

  it("should append multiple lines in order", () => {
    fileLogModule.logToFile("multi.log", "line 1");
    fileLogModule.logToFile("multi.log", "line 2");
    fileLogModule.logToFile("multi.log", "line 3");
    const lines = readLines(join(tmpDir, "multi.log"));
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("line 1");
    expect(lines[2]).toContain("line 3");
  });

  it("should never throw when the log dir is unwritable", () => {
    getLogDirSpy.mockReturnValue("/this/path/cannot/exist/ever");
    expect(() => fileLogModule.logToFile("x.log", "boom")).not.toThrow();
  });

  // ─── rotation ────────────────────────────────────────────────────────────

  it("should rotate to .1 when file size exceeds cap", () => {
    const logPath = join(tmpDir, "rot.log");
    // Write two lines that together exceed the tiny cap
    fileLogModule.logToFile("rot.log", "first line — will be rotated away");
    const tinyMax = 30; // bytes — well below one line
    fileLogModule.logToFile("rot.log", "second line triggers rotation", {
      maxBytes: tinyMax,
    });
    // .1 backup must contain the original content
    const backupPath = logPath + ".1";
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, "utf-8");
    expect(backupContent).toContain("first line");
    // Fresh log contains only the new line
    const freshLines = readLines(logPath);
    expect(freshLines.length).toBe(1);
    expect(freshLines[0]).toContain("second line triggers rotation");
  });

  it("should replace existing .1 on second rotation", () => {
    const backupPath = join(tmpDir, "rot2.log.1");
    // First rotation
    fileLogModule.logToFile("rot2.log", "gen1");
    fileLogModule.logToFile("rot2.log", "gen2 triggers first rotate", {
      maxBytes: 10,
    });
    expect(existsSync(backupPath)).toBe(true);
    const gen1Content = readFileSync(backupPath, "utf-8");
    expect(gen1Content).toContain("gen1");
    // Second rotation — gen2 becomes .1
    fileLogModule.logToFile("rot2.log", "gen3 triggers second rotate", {
      maxBytes: 10,
    });
    const gen2Content = readFileSync(backupPath, "utf-8");
    expect(gen2Content).toContain("gen2 triggers first rotate");
    // Original gen1 is gone (only one backup generation kept)
    expect(gen2Content).not.toContain("gen1");
  });

  it("should not rotate if file size is under cap", () => {
    fileLogModule.logToFile("small.log", "tiny");
    const logPath = join(tmpDir, "small.log");
    const sizeBefore = statSync(logPath).size;
    fileLogModule.logToFile("small.log", "also tiny", {
      maxBytes: 10 * 1024 * 1024,
    });
    expect(existsSync(logPath + ".1")).toBe(false);
    // File grew
    expect(statSync(logPath).size).toBeGreaterThan(sizeBefore);
  });

  // ─── logSidecar convenience ───────────────────────────────────────────────

  it("logSidecar should write to SIDECAR_LOG_FILE", () => {
    fileLogModule.logSidecar("sidecar started");
    const logPath = join(tmpDir, fileLogModule.SIDECAR_LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain("sidecar started");
  });

  it("logDashboard should write to DASHBOARD_LOG_FILE", () => {
    fileLogModule.logDashboard("dashboard started pid=1234");
    const logPath = join(tmpDir, fileLogModule.DASHBOARD_LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain("dashboard started pid=1234");
  });

  it("DASHBOARD_LOG_FILE constant should be 'dashboard.log'", () => {
    expect(fileLogModule.DASHBOARD_LOG_FILE).toBe("dashboard.log");
  });

  // ─── readLastLines ────────────────────────────────────────────────────────

  it("should return an empty array when the file is missing", () => {
    const result = fileLogModule.readLastLines(
      join(tmpDir, "nonexistent.log"),
      10,
    );
    expect(result).toEqual([]);
  });

  it("should return the last N lines", () => {
    const logPath = join(tmpDir, "tail.log");
    for (let i = 1; i <= 10; i++) {
      fileLogModule.logToFile("tail.log", `line ${i}`);
    }
    const last3 = fileLogModule.readLastLines(logPath, 3);
    expect(last3.length).toBe(3);
    expect(last3[2]).toContain("line 10");
    expect(last3[0]).toContain("line 8");
  });

  it("should return all lines when N exceeds line count", () => {
    fileLogModule.logToFile("short.log", "only line");
    const result = fileLogModule.readLastLines(join(tmpDir, "short.log"), 100);
    expect(result.length).toBe(1);
  });

  it("should not include trailing empty lines in the count", () => {
    const logPath = join(tmpDir, "trail.log");
    fileLogModule.logToFile("trail.log", "line 1");
    fileLogModule.logToFile("trail.log", "line 2");
    const result = fileLogModule.readLastLines(logPath, 5);
    expect(result.length).toBe(2);
  });
});
