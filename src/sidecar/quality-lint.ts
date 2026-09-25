/**
 * ESLint / Prettier runners (D1 of docs/plans/2026-09-24-hardening-sweep.md).
 *
 * The one rule: only an explicit `file`, resolved inside the project, is ever
 * rewritten. Project-wide runs are report-only (`eslint --format json .`,
 * `prettier --list-different .`). Split from quality-runners.ts by length;
 * this module imports from it, never the reverse (no cycle).
 */

import { statSync } from "node:fs";
import {
  getToolCommand,
  runWithTimeout,
  type FixMode,
  type ToolResult,
} from "./quality-runners.js";
import {
  resolveQualityTarget,
  summarizeEslintJson,
  listedFiles,
  outputLines,
  MAX_LISTED,
} from "./quality-summary.js";

/**
 * ESLint. With a `file` (D1): `--fix <resolved file>` — the only rewrite.
 * Without: `--format json .` — report-only, never `--fix`.
 */
export async function runEslint(
  projectPath: string,
  filePath: string | undefined,
  timeout: number,
): Promise<ToolResult> {
  const start = Date.now();
  // Throws (before anything is spawned) for a file outside the project.
  const target = filePath ? resolveQualityTarget(projectPath, filePath) : null;
  const fixMode: FixMode = target ? "file" : "none";
  const eslint = getToolCommand(projectPath, "eslint");

  // Detect auto-fix by the RESOLVED file's mtime (not the sidecar's cwd).
  const mtimeOf = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const mtimeBefore = target ? mtimeOf(target) : 0;

  const cmd = target
    ? [...eslint, "--fix", target]
    : [...eslint, "--format", "json", "."];
  const result = await runWithTimeout(cmd, projectPath, timeout);
  const durationMs = Date.now() - start;

  if (result.timedOut) {
    return {
      ok: false,
      errors: ["eslint timed out"],
      durationMs,
      timedOut: true,
      fixMode,
      autoFixed: false,
    };
  }

  const ok = result.exitCode === 0;

  if (!target) {
    const summary = summarizeEslintJson(result.stdout, projectPath);
    if (!summary) {
      return {
        ok: false,
        errors: outputLines(result.stderr || result.stdout),
        durationMs,
        fixMode,
        autoFixed: false,
      };
    }
    return {
      ok: ok && summary.errorCount === 0,
      errors: summary.locations,
      durationMs,
      fixMode,
      autoFixed: false,
      errorCount: summary.errorCount,
      warningCount: summary.warningCount,
      topRules: summary.topRules,
    };
  }

  const errors = ok ? [] : outputLines(result.stdout || result.stderr);
  const autoFixed = ok && mtimeBefore > 0 && mtimeOf(target) !== mtimeBefore;
  return { ok, errors, durationMs, fixMode, autoFixed };
}

/**
 * Prettier. With a `file` (D1): `--check <file>`, then `--write <file>` ONLY
 * when the check exits 1 (unformatted) — never on 2 (tool error) — and the
 * write's own exit code decides `ok`/`autoFixed`. Without: `--list-different .`
 * — report-only, never `--write`.
 */
export async function runPrettier(
  projectPath: string,
  filePath: string | undefined,
  timeout: number,
): Promise<ToolResult> {
  const start = Date.now();
  const target = filePath ? resolveQualityTarget(projectPath, filePath) : null;
  const prettier = getToolCommand(projectPath, "prettier");
  const timedOut = (what: string, fixMode: FixMode): ToolResult => ({
    ok: false,
    errors: [`${what} timed out`],
    durationMs: Date.now() - start,
    timedOut: true,
    fixMode,
    autoFixed: false,
  });

  if (!target) {
    const list = await runWithTimeout(
      [...prettier, "--list-different", "."],
      projectPath,
      timeout,
    );
    if (list.timedOut) return timedOut("prettier", "none");
    const base = {
      durationMs: Date.now() - start,
      fixMode: "none" as const,
      autoFixed: false,
    };
    // 0 = all formatted, 1 = files listed, anything else = tool error.
    if (list.exitCode !== 0 && list.exitCode !== 1) {
      return {
        ...base,
        ok: false,
        errors: outputLines(list.stderr || list.stdout),
      };
    }
    const all = listedFiles(list.stdout);
    const files = all.slice(0, MAX_LISTED);
    return {
      ...base,
      ok: list.exitCode === 0,
      errors: files,
      files,
      fileCount: all.length,
    };
  }

  const check = await runWithTimeout(
    [...prettier, "--check", target],
    projectPath,
    timeout,
  );
  if (check.timedOut) return timedOut("prettier", "file");
  if (check.exitCode === 0) {
    return {
      ok: true,
      errors: [],
      durationMs: Date.now() - start,
      fixMode: "file",
      autoFixed: false,
    };
  }
  if (check.exitCode !== 1) {
    return {
      ok: false,
      errors: outputLines(check.stderr || check.stdout),
      durationMs: Date.now() - start,
      fixMode: "file",
      autoFixed: false,
    };
  }

  const fix = await runWithTimeout(
    [...prettier, "--write", target],
    projectPath,
    timeout,
  );
  if (fix.timedOut) return timedOut("prettier --write", "file");
  const fixed = fix.exitCode === 0;
  return {
    ok: fixed,
    errors: fixed ? [] : outputLines(fix.stderr || fix.stdout),
    durationMs: Date.now() - start,
    fixMode: "file",
    autoFixed: fixed,
  };
}
