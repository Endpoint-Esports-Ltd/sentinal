/**
 * Quality Check Summaries (D1 of docs/plans/2026-09-24-hardening-sweep.md)
 *
 * Pure helpers for the eslint/prettier runners in quality-runners.ts:
 *   - resolveQualityTarget: the ONLY way a caller-supplied `file` becomes a
 *     fix target — resolved against the project, refused outside it.
 *   - summarizeEslintJson / listedFiles: turn report-only output
 *     (`eslint --format json .`, `prettier --list-different .`) into counts
 *     and a bounded list, so project-wide mode reports instead of rewriting.
 *
 * No imports from quality-runners.ts (it re-exports from here — no cycle).
 */

import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/** Maximum project-wide entries (files / `file:line rule`) returned. */
export const MAX_LISTED = 20;
/** Maximum rules in `topRules`. */
export const MAX_TOP_RULES = 5;

export interface RuleCount {
  rule: string;
  count: number;
}

export interface EslintSummary {
  errorCount: number;
  warningCount: number;
  topRules: RuleCount[];
  /** First MAX_LISTED `file:line rule` entries (paths project-relative). */
  locations: string[];
}

/** realpath of the nearest existing ancestor + the non-existent remainder. */
function realpathLoose(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `filePath` against `projectPath` (NOT the process cwd) and refuse
 * anything that is not strictly inside the project — including the project
 * root itself (that would be a project-wide fix) and symlink escapes.
 * Returns the absolute (not realpath'd) path to hand to the tool.
 */
export function resolveQualityTarget(
  projectPath: string,
  filePath: string,
): string {
  const abs = resolve(projectPath, filePath);
  const rel = relative(realpathLoose(resolve(projectPath)), realpathLoose(abs));
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `File is outside the project: ${filePath} (project: ${projectPath}). ` +
        "quality_report only auto-fixes a file inside the project.",
    );
  }
  return abs;
}

/** Non-empty trimmed lines, capped. */
export function outputLines(text: string, max = 10): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, max);
}

/** All non-empty lines of `prettier --list-different` stdout. */
export function listedFiles(stdout: string): string[] {
  return outputLines(stdout, Number.MAX_SAFE_INTEGER);
}

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  line?: number;
  message?: string;
}
interface EslintFileResult {
  filePath?: string;
  errorCount?: number;
  warningCount?: number;
  messages?: EslintMessage[];
}

/** Parse `eslint --format json` stdout; null when it is not that shape. */
export function summarizeEslintJson(
  stdout: string,
  projectPath: string,
): EslintSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  let errorCount = 0;
  let warningCount = 0;
  const rules = new Map<string, number>();
  const locations: string[] = [];

  for (const f of parsed as EslintFileResult[]) {
    const messages = Array.isArray(f?.messages) ? f.messages : [];
    errorCount +=
      f.errorCount ?? messages.filter((m) => m.severity === 2).length;
    warningCount +=
      f.warningCount ?? messages.filter((m) => m.severity === 1).length;
    const file = f.filePath ? relative(projectPath, f.filePath) : "?";
    for (const m of messages) {
      if (m.ruleId) rules.set(m.ruleId, (rules.get(m.ruleId) ?? 0) + 1);
      if (locations.length < MAX_LISTED) {
        const what = m.ruleId ?? m.message ?? "?";
        locations.push(`${file}:${m.line ?? 0} ${what}`);
      }
    }
  }

  const topRules = [...rules.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
    .slice(0, MAX_TOP_RULES);

  return { errorCount, warningCount, topRules, locations };
}
