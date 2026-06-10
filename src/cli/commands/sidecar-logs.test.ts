/**
 * sidecar-logs tests
 *
 * Tests the buildLogsReport() helper that powers `sentinal sidecar logs`.
 * All tests use spyOn(fileLogModule, "getLogDir") to redirect log reads to
 * a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../../test-helpers.js";
import * as fileLogModule from "../../utils/file-log.js";
import {
  buildLogsReport,
  type BuildLogsReportOptions,
} from "./sidecar-logs.js";

describe("buildLogsReport", () => {
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

  function writeLog(fileName: string, lines: string[]): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, fileName), lines.join("\n") + "\n");
  }

  // ─── missing files ───────────────────────────────────────────────────────

  it("should note when sidecar.log is missing (all mode)", () => {
    const report = buildLogsReport({ lines: 10, file: "all" });
    expect(report).toContain("sidecar.log");
    expect(report).toContain("(no log file found)");
  });

  it("should note when plugin.debug.log is missing (all mode)", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    const report = buildLogsReport({ lines: 10, file: "all" });
    expect(report).toContain("plugin.debug.log");
    expect(report).toContain("(no log file found)");
  });

  it("should show only sidecar.log when --file sidecar", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    writeLog("plugin.debug.log", ["2026-06-09T00:00:00.000Z plugin: hello"]);
    const report = buildLogsReport({ lines: 10, file: "sidecar" });
    expect(report).toContain("sidecar.log");
    expect(report).not.toContain("plugin.debug.log");
  });

  it("should show only plugin.debug.log when --file plugin", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    writeLog("plugin.debug.log", ["2026-06-09T00:00:00.000Z plugin: hello"]);
    const report = buildLogsReport({ lines: 10, file: "plugin" });
    expect(report).not.toContain("sidecar.log");
    expect(report).toContain("plugin.debug.log");
  });

  // ─── line limiting ───────────────────────────────────────────────────────

  it("should return the last N lines", () => {
    const allLines = Array.from(
      { length: 20 },
      (_, i) => `2026-06-09T00:00:0${i % 10}.000Z line ${i + 1}`,
    );
    writeLog("sidecar.log", allLines);
    const report = buildLogsReport({ lines: 5, file: "sidecar" });
    expect(report).toContain("line 20");
    expect(report).not.toContain("line 1\n");
    // Header shows total vs shown
    expect(report).toContain("last 5");
  });

  it("should show all lines when N exceeds total", () => {
    writeLog("sidecar.log", [
      "2026-06-09T00:00:00.000Z line 1",
      "2026-06-09T00:00:01.000Z line 2",
    ]);
    const report = buildLogsReport({ lines: 100, file: "sidecar" });
    expect(report).toContain("line 1");
    expect(report).toContain("line 2");
  });

  // ─── both files in all mode ──────────────────────────────────────────────

  it("should include both files in all mode with content", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    writeLog("plugin.debug.log", ["2026-06-09T00:00:00.000Z plugin: hello"]);
    const report = buildLogsReport({ lines: 10, file: "all" });
    expect(report).toContain("sidecar.log");
    expect(report).toContain("sidecar: started");
    expect(report).toContain("plugin.debug.log");
    expect(report).toContain("plugin: hello");
  });

  // ─── dashboard log ────────────────────────────────────────────────────────

  it("should show only dashboard.log when --file dashboard", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    writeLog("dashboard.log", ["2026-06-09T00:00:00.000Z dashboard: started pid=1234"]);
    const report = buildLogsReport({ lines: 10, file: "dashboard" });
    expect(report).toContain("dashboard.log");
    expect(report).toContain("dashboard: started pid=1234");
    expect(report).not.toContain("sidecar.log");
  });

  it("should include dashboard.log in all mode", () => {
    writeLog("sidecar.log", ["2026-06-09T00:00:00.000Z sidecar: started"]);
    writeLog("dashboard.log", ["2026-06-09T00:00:00.000Z dashboard: started pid=1234"]);
    writeLog("plugin.debug.log", ["2026-06-09T00:00:00.000Z plugin: hello"]);
    const report = buildLogsReport({ lines: 10, file: "all" });
    expect(report).toContain("dashboard.log");
    expect(report).toContain("dashboard: started pid=1234");
    expect(report).toContain("sidecar.log");
    expect(report).toContain("plugin.debug.log");
  });

  it("should note when dashboard.log is missing in dashboard mode", () => {
    const report = buildLogsReport({ lines: 10, file: "dashboard" });
    expect(report).toContain("dashboard.log");
    expect(report).toContain("(no log file found)");
  });
});
