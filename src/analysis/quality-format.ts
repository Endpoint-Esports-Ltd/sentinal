/**
 * quality_report rendering. Split from mcp-tools.ts by length.
 *
 * D1: project-wide results are report-only — list the unformatted files and
 * real eslint counts. Every D1 field is optional, so a result from an old
 * (≤ v1.38) sidecar still renders through the legacy branches.
 */

import type {
  QualityCheckResult,
  ToolResult,
} from "../sidecar/quality-routes.js";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function header(name: string, t: ToolResult, extra: string[] = []): string {
  const meta = [
    `${(t.durationMs / 1000).toFixed(1)}s`,
    ...extra,
    t.fixMode === "none" ? "report-only" : "",
    t.autoFixed ? "auto-fixed" : "",
    t.timedOut ? "TIMED OUT" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `### ${name} (${meta})`;
}

function list(lines: string[], items: string[], total: number): void {
  for (const e of items) lines.push(`  - ${e}`);
  if (total > items.length)
    lines.push(`  - ... and ${total - items.length} more`);
}

function renderTsc(lines: string[], t: ToolResult): void {
  lines.push(header("TypeScript", t, [t.incremental ? "incremental" : "full"]));
  if (t.ok) {
    lines.push("- 0 errors");
  } else {
    lines.push(`- ${plural(t.errors.length, "error")}`);
    list(lines, t.errors.slice(0, 10), t.errors.length);
  }
}

function renderEslint(lines: string[], t: ToolResult): void {
  lines.push(header("ESLint", t));
  if (t.errorCount !== undefined) {
    // Project-wide, report-only: real totals from `--format json`.
    const warnings = t.warningCount ?? 0;
    lines.push(
      `- ${plural(t.errorCount, "error")}, ${plural(warnings, "warning")}`,
    );
    if (t.topRules?.length) {
      const rules = t.topRules.map((r) => `${r.rule} (${r.count})`);
      lines.push(`- Top rules: ${rules.join(", ")}`);
    }
    list(lines, t.errors, t.errorCount + warnings);
    return;
  }
  if (t.ok) {
    lines.push(t.autoFixed ? "- Auto-fixed issues" : "- No issues");
  } else {
    lines.push(t.fixMode === "file" ? "- Problems remaining:" : "- Problems:");
    list(lines, t.errors.slice(0, 10), t.errors.length);
  }
}

function renderPrettier(
  lines: string[],
  t: ToolResult,
  file: string | undefined,
): void {
  lines.push(header("Prettier", t));
  if (t.fileCount !== undefined) {
    if (t.fileCount === 0) {
      lines.push("- All files formatted correctly");
    } else {
      lines.push(
        `- ${plural(t.fileCount, "file")} not formatted (nothing was modified; pass \`file\` to fix one):`,
      );
      list(lines, t.files ?? t.errors, t.fileCount);
    }
    return;
  }
  if (t.ok) {
    if (t.fixMode === "file") {
      lines.push(t.autoFixed ? `- Formatted ${file}` : "- Formatted correctly");
    } else {
      // Legacy (≤ v1.38) sidecar result.
      lines.push(
        t.autoFixed ? "- Formatted files" : "- All files formatted correctly",
      );
    }
  } else {
    lines.push("- Prettier failed:");
    list(lines, t.errors.slice(0, 10), t.errors.length);
  }
}

export function formatQualityReport(
  project: string,
  file: string | undefined,
  result: QualityCheckResult,
): string {
  const lines: string[] = [
    "## Quality Report",
    `**Project:** ${project}`,
    file
      ? `**File:** ${file} (eslint/prettier auto-fix this file only)`
      : "**Scope:** Project-wide (report-only — eslint/prettier modified nothing)",
    "",
  ];

  if (result.tsc) {
    renderTsc(lines, result.tsc);
    lines.push("");
  }
  if (result.eslint) {
    renderEslint(lines, result.eslint);
    lines.push("");
  }
  if (result.prettier) {
    renderPrettier(lines, result.prettier, file);
    lines.push("");
  }

  return lines.join("\n");
}
