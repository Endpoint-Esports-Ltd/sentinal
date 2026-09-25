/**
 * Error classifier tests — D9 of docs/plans/2026-09-24-hardening-sweep.md.
 *
 * Fixtures are REAL runner output captured verbatim (bun 1.3.10, tsc, eslint 9,
 * git) unless marked otherwise. The classifier is reused by the Task 18 DB
 * cleanup script on stored "Error" sections, which carry no exit code and are
 * truncated at 500 characters — so the text heuristics must stand alone.
 */

import { describe, it, expect } from "bun:test";
import { isErrorOutput, isPassingTestSummary } from "./error-classifier.js";

// ─── Real outputs ─────────────────────────────────────────────────────────────

const BUN_PASS =
  "bun test v1.3.10 (30e609e0)\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [21.00ms]\n";

const BUN_FAIL =
  "bun test v1.3.10 (30e609e0)\n\nfail.test.ts:\nerror: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n\n(fail) adds [3.15ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [18.00ms]\n";

const BUN_UNHANDLED =
  'bun test v1.3.10 (30e609e0)\n\nunh.test.ts:\n1 | import { it, expect } from "bun:test";\n                                                                   ^\nerror: boom late\n      at <anonymous> (/private/var/folders/t11/unh.test.ts:2:64)\n(fail) ok2 [1.96ms]\n\n 1 pass\n 1 fail\n 1 expect() calls\nRan 2 tests across 1 file. [18.00ms]\n';

const TSC_ERROR =
  "bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";

const ESLINT_WARN_ONLY =
  "\n/private/var/folders/t11/lint.ts\n  0:0  warning  File ignored because no matching configuration was supplied\n\n✖ 1 problem (0 errors, 1 warning)\n";

// eslint "stylish" error form (same formatter as above, error severity).
const ESLINT_ERROR =
  "\n/src/lint.ts\n  2:5  error  'y' is never reassigned. Use 'const' instead  prefer-const\n\n✖ 1 problem (1 error, 0 warnings)\n";

// `git log --oneline` — commit subjects talk ABOUT errors without being one.
const GIT_LOG =
  "3ca0292 chore(memory): share the v1.38.0 decision records\n" +
  "a1b2c3d fix(capture): stop reading ' 0 fail' as a failure\n" +
  "d4e5f6a fix(spec): error when the plan file does not exist\n" +
  "0f9e8d7 feat(hooks): log the exception and fail open\n";

const GIT_STATUS =
  "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n";

describe("isErrorOutput — a known exit code overrides the text", () => {
  it("exit 0 is never an error, whatever the text says", () => {
    expect(isErrorOutput(TSC_ERROR, 0)).toBe(false);
    expect(isErrorOutput("ERROR: something FAILED", 0)).toBe(false);
  });

  it("a non-zero exit is always an error, even with no or passing text", () => {
    expect(isErrorOutput("", 1)).toBe(true);
    expect(isErrorOutput(undefined, 2)).toBe(true);
    expect(isErrorOutput(BUN_PASS, 1)).toBe(true);
  });

  it("null/undefined exit falls back to the text", () => {
    expect(isErrorOutput(TSC_ERROR, null)).toBe(true);
    expect(isErrorOutput(BUN_PASS, null)).toBe(false);
    expect(isErrorOutput(TSC_ERROR)).toBe(true);
  });
});

describe("isErrorOutput — real passing output is not an error", () => {
  it("a passing bun run (' 0 fail')", () => {
    expect(isErrorOutput(BUN_PASS)).toBe(false);
  });

  it("a passing bun run truncated to its head (stored 'Error' sections)", () => {
    expect(isErrorOutput(BUN_PASS.slice(0, 60))).toBe(false);
  });

  it("a passing bun run whose test titles mention errors", () => {
    const withTitles =
      "bun test v1.3.10\n\nsrc/a.test.ts:\n(pass) returns null when the file does not exist [0.10ms]\n(pass) reports an ERROR when the exception is thrown and FAILED [0.05ms]\n(skip) fails later\n";
    expect(isErrorOutput(withTitles)).toBe(false);
  });

  it("a passing bun run with console noise from the code under test", () => {
    const noisy =
      "bun test v1.3.10\n[sentinal] ERROR sidecar unreachable (expected in test)\n\n 40 pass\n 0 fail\nRan 40 tests across 3 files. [1.2s]\n";
    expect(isErrorOutput(noisy)).toBe(false);
  });

  it("clean tsc / eslint (empty) and eslint warnings only", () => {
    expect(isErrorOutput("")).toBe(false);
    expect(isErrorOutput(ESLINT_WARN_ONLY)).toBe(false);
  });

  it("tsc --watch 'Found 0 errors'", () => {
    expect(isErrorOutput("Found 0 errors. Watching for file changes.\n")).toBe(
      false,
    );
  });

  it("git log / git status", () => {
    expect(isErrorOutput(GIT_LOG)).toBe(false);
    expect(isErrorOutput(GIT_STATUS)).toBe(false);
  });

  it("other runners' passing summaries", () => {
    expect(isErrorOutput("Tests:       12 passed, 12 total\n")).toBe(false);
    expect(
      isErrorOutput(" Test Files  3 passed (3)\n      Tests  12 passed (12)\n"),
    ).toBe(false);
  });
});

describe("isErrorOutput — real failing output is an error", () => {
  it("failing bun runs", () => {
    expect(isErrorOutput(BUN_FAIL)).toBe(true);
    expect(isErrorOutput(BUN_UNHANDLED)).toBe(true);
    expect(isErrorOutput("bun test v1.3.10\n\n 0 pass\n 3 fail\n")).toBe(true);
  });

  it("a bun run with 0 fail but an unhandled error between tests", () => {
    expect(
      isErrorOutput("error: boom\n\n 3 pass\n 0 fail\n 1 error\nRan 3 tests\n"),
    ).toBe(true);
  });

  it("tsc and eslint errors", () => {
    expect(isErrorOutput(TSC_ERROR)).toBe(true);
    expect(isErrorOutput("Found 2 errors in 1 file.\n")).toBe(true);
    expect(isErrorOutput(ESLINT_ERROR)).toBe(true);
  });

  it("runtime errors and stack traces", () => {
    expect(
      isErrorOutput(
        "TypeError: undefined is not a function\n    at foo (a.js:1:2)",
      ),
    ).toBe(true);
    expect(isErrorOutput("error: Cannot find module './x'")).toBe(true);
    expect(isErrorOutput("fatal: not a git repository")).toBe(true);
  });

  it("other runners' failing summaries", () => {
    expect(isErrorOutput("Tests: 2 failed, 10 passed, 12 total")).toBe(true);
    expect(isErrorOutput("=== 1 FAILED, 3 passed in 0.2s ===")).toBe(true);
  });
});

describe("isPassingTestSummary", () => {
  it("recognises a clean bun / jest / vitest summary", () => {
    expect(isPassingTestSummary(BUN_PASS)).toBe(true);
    expect(isPassingTestSummary("Tests:       12 passed, 12 total")).toBe(true);
    expect(isPassingTestSummary("      Tests  12 passed (12)")).toBe(true);
  });

  it("rejects summaries with any failure or error count", () => {
    expect(isPassingTestSummary(BUN_FAIL)).toBe(false);
    expect(isPassingTestSummary(" 3 pass\n 0 fail\n 1 error\n")).toBe(false);
    expect(isPassingTestSummary("Tests: 2 failed, 10 passed, 12 total")).toBe(
      false,
    );
    expect(isPassingTestSummary(TSC_ERROR)).toBe(false);
  });
});
