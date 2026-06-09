/**
 * Sidecar Logs Helper
 *
 * Provides `buildLogsReport()` — a pure function that reads recent lines from
 * sidecar.log and/or plugin.debug.log and formats them for terminal output.
 * Extracted here so it can be unit-tested without spawning the CLI.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  readLastLines,
  getLogDir,
  SIDECAR_LOG_FILE,
  PLUGIN_LOG_FILE,
} from "../../utils/file-log.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogFileFilter = "sidecar" | "plugin" | "all";

export interface BuildLogsReportOptions {
  /** Number of tail lines to show per file. */
  lines: number;
  /** Which log file(s) to include. */
  file: LogFileFilter;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function totalLines(filePath: string): number {
  try {
    if (!existsSync(filePath)) return 0;
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

function renderFile(label: string, filePath: string, n: number): string {
  const total = totalLines(filePath);
  if (total === 0) {
    return `── ${label} ──\n(no log file found)\n`;
  }
  const shown = Math.min(n, total);
  const lines = readLastLines(filePath, n);
  return `── ${label} (last ${shown} of ${total} lines) ──\n${lines.join("\n")}\n`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a human-readable report of recent sidecar / plugin log lines.
 * All file reads go through readLastLines/getLogDir so tests can spy on getLogDir.
 */
export function buildLogsReport(opts: BuildLogsReportOptions): string {
  const dir = getLogDir();
  const sections: string[] = [];

  if (opts.file === "sidecar" || opts.file === "all") {
    sections.push(
      renderFile("sidecar.log", join(dir, SIDECAR_LOG_FILE), opts.lines),
    );
  }
  if (opts.file === "plugin" || opts.file === "all") {
    sections.push(
      renderFile("plugin.debug.log", join(dir, PLUGIN_LOG_FILE), opts.lines),
    );
  }

  return sections.join("\n");
}
