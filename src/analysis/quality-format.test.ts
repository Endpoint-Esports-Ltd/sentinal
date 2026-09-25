/**
 * quality_report rendering (D1): project-wide output lists the unformatted
 * files and real eslint counts, and says nothing was modified.
 */

import { describe, it, expect } from "bun:test";
import { formatQualityReport } from "./quality-format.js";

describe("formatQualityReport — project-wide (report-only)", () => {
  const text = formatQualityReport("/p", undefined, {
    prettier: {
      ok: false,
      errors: ["src/a.ts", "src/b.ts"],
      files: ["src/a.ts", "src/b.ts"],
      fileCount: 27,
      durationMs: 1200,
      fixMode: "none",
      autoFixed: false,
    },
    eslint: {
      ok: false,
      errors: ["src/a.ts:3 no-unused-vars", "src/b.ts:1 Parsing error"],
      errorCount: 12,
      warningCount: 4,
      topRules: [
        { rule: "no-unused-vars", count: 9 },
        { rule: "prefer-const", count: 3 },
      ],
      durationMs: 800,
      fixMode: "none",
      autoFixed: false,
    },
  });

  it("states the scope is report-only", () => {
    expect(text).toContain("report-only");
    expect(text).not.toContain("Auto-fixed");
    expect(text).not.toContain("Formatted files");
  });

  it("lists unformatted files with the real total", () => {
    expect(text).toContain("27 files not formatted");
    expect(text).toContain("  - src/a.ts");
    expect(text).toContain("  - src/b.ts");
    expect(text).toContain("... and 25 more");
  });

  it("shows real eslint counts, top rules and locations", () => {
    expect(text).toContain("12 errors, 4 warnings");
    expect(text).toContain("no-unused-vars (9)");
    expect(text).toContain("prefer-const (3)");
    expect(text).toContain("  - src/a.ts:3 no-unused-vars");
  });
});

describe("formatQualityReport — single file", () => {
  it("reports the file as formatted only when autoFixed", () => {
    const fixed = formatQualityReport("/p", "/p/src/a.ts", {
      prettier: {
        ok: true,
        errors: [],
        durationMs: 10,
        fixMode: "file",
        autoFixed: true,
      },
    });
    expect(fixed).toContain("Formatted /p/src/a.ts");

    const failed = formatQualityReport("/p", "/p/src/a.ts", {
      prettier: {
        ok: false,
        errors: ["[error] SyntaxError"],
        durationMs: 10,
        fixMode: "file",
        autoFixed: false,
      },
    });
    expect(failed).not.toContain("Formatted /p/src/a.ts");
    expect(failed).toContain("[error] SyntaxError");
  });
});

describe("formatQualityReport — result from an old (≤ v1.38) sidecar", () => {
  it("still renders without the optional D1 fields", () => {
    const text = formatQualityReport("/p", undefined, {
      tsc: { ok: true, errors: [], durationMs: 5, incremental: true },
      eslint: { ok: true, errors: [], durationMs: 5, autoFixed: false },
      prettier: { ok: true, errors: [], durationMs: 5, autoFixed: false },
    });
    expect(text).toContain("0 errors");
    expect(text).toContain("No issues");
    expect(text).toContain("All files formatted correctly");
  });
});
