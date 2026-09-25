/**
 * Error classifier — "does this tool output represent a failure?"
 *
 * Pure and dependency-free on purpose: the OpenCode plugin bundles it, and the
 * hardening-sweep Task 18 cleanup script reuses it on the "Error" sections of
 * stored observations (which carry no exit code and are truncated to 500
 * characters), so the definition matches the shipped capture code exactly.
 *
 * D9 (docs/plans/2026-09-24-hardening-sweep.md):
 *   - A KNOWN exit code overrides the text: 0 is not an error, non-zero is.
 *   - A count of ZERO is not evidence. The old `/\bfail\b/i` matched every
 *     passing bun run's " 0 fail" — 147 stored "Fixed issue" rows had a
 *     passing test run as their "error".
 *   - Words ABOUT errors are not errors: test titles, commit subjects and
 *     grep hits mention "error", "exception", "does not exist" all the time,
 *     so indicators match the SHAPE runners and compilers print.
 */

/** Non-zero failure/error counts: bun "1 fail", jest "2 failed", tsc "Found 3 errors". */
const NONZERO_FAILURE_COUNT =
  /\b[1-9]\d*\s+(?:fail|failed|failures?|errors?)\b/i;

const ERROR_INDICATORS: readonly RegExp[] = [
  /\berror\s*TS\d+/i, // tsc
  /\bERROR\b/, // upper-case log level / "ERROR:" (case-sensitive)
  /\bFAILED\b/, // pytest / npm / jest upper-case marker (case-sensitive)
  /(?:^|:)\s*FAIL\s+\S+\.(?:spec|test)\.\w+/m, // jest/vitest file marker, also grep-numbered
  NONZERO_FAILURE_COUNT,
  /^\(fail\)/m, // bun per-test failure line
  /^(?:error|fatal)(?:\[\w+\])?:/m, // bun, git, rustc — at column 0
  /^(?:Uncaught\s+)?[A-Z]\w*(?:Error|Exception):\s/m, // JS runtime errors
  /^\s+at\s+.*:\d+:\d+\)?\s*$/m, // a stack frame
  /\b(?:uncaught|unhandled)\s+(?:exception|error|rejection)\b/i,
  /\b(?:command|build|compilation)\s+failed\b/i,
  /Cannot find module/,
  /is not assignable to/,
  /does not exist on type/,
  /\bunexpected token\b/i,
  /\bENOENT\b/,
];

/** Per-test result lines whose titles are free text ("(pass) handles the ERROR…"). */
const TEST_TITLE_LINE = /^\((?:pass|skip|todo)\)\s.*$/gm;

const COMPILER_ERROR = /\berror\s*TS\d+/i;
const BUN_PASS_LINE = /^\s*[1-9]\d*\s+pass\s*$/m;
const BUN_ZERO_FAIL_LINE = /^\s*0\s+fail\s*$/m;
const JEST_VITEST_PASSED = /\bTests:?\s+\d+\s+passed\b/;

/**
 * True when `text` carries a test-runner summary (bun, jest, vitest) that
 * reports passes and NO failure or error count. Such a run passed, however
 * much error-looking noise the code under test printed along the way.
 */
export function isPassingTestSummary(text: string): boolean {
  if (NONZERO_FAILURE_COUNT.test(text)) return false;
  // One command can run tests AND a compiler (`bun test && tsc`): a passing
  // summary must not hide compiler errors printed alongside it.
  if (COMPILER_ERROR.test(text)) return false;
  const bunPassed = BUN_PASS_LINE.test(text) && BUN_ZERO_FAIL_LINE.test(text);
  return bunPassed || JEST_VITEST_PASSED.test(text);
}

/**
 * Classify tool output as an error.
 *
 * @param text     the tool output (may be truncated, empty or absent)
 * @param exitCode the process exit code when KNOWN — a number overrides the
 *                 text entirely; `null`/`undefined` falls back to heuristics
 */
export function isErrorOutput(
  text: string | null | undefined,
  exitCode?: number | null,
): boolean {
  if (typeof exitCode === "number") return exitCode !== 0;
  if (!text) return false;
  if (isPassingTestSummary(text)) return false;
  const body = text.replace(TEST_TITLE_LINE, "");
  return ERROR_INDICATORS.some((p) => p.test(body));
}
