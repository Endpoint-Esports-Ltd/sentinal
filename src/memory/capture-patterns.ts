/**
 * Capture types, file/test patterns and small predicates shared by the
 * capture heuristics (`capture.ts`, `capture-buffer.ts`,
 * `capture-detectors.ts`).
 *
 * ⛔ Bundled into the OpenCode plugin via `capture.ts` — import nothing
 * beyond `./types.js` (types only) and `./error-classifier.js`.
 */

import type { ObservationType } from "./types.js";
import { isErrorOutput } from "./error-classifier.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A heuristic that turns an earlier error into a capture, consuming it. */
export type CaptureConsumer = "fix" | "build" | "tdd";

export interface ToolEvent {
  toolName: string;
  /** Relevant file path from tool input/output */
  filePath?: string;
  /** Whether the tool succeeded */
  success: boolean;
  /** Content of the tool output (truncated) */
  output?: string;
  /** Timestamp of the event */
  timestamp: number;
  /**
   * Process exit code when KNOWN (OpenCode `metadata.exit`; 0 for a Claude
   * Code Bash seen on PostToolUse, which fires only on success). Overrides
   * the text heuristics in `isErrorOutput`.
   */
  exitCode?: number | null;
  /**
   * Heuristics this error has already produced a capture for. Stored ON the
   * event so it survives the CC hook's JSON-persisted buffer — an error, once
   * it yields a fix, never yields another.
   */
  consumedBy?: CaptureConsumer[];
}

export interface CaptureDecision {
  shouldCapture: boolean;
  type: ObservationType;
  title: string;
  /** Suggested content for the observation */
  content: string;
  /** File paths related to this capture */
  filePaths: string[];
  /** Suggested tags */
  tags: string[];
  /** Confidence level 0-1 */
  confidence: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum confidence to trigger auto-capture */
export const MIN_CAPTURE_CONFIDENCE = 0.6;

export const CONFIG_FILE_PATTERNS = [
  /tsconfig.*\.json$/,
  /package\.json$/,
  /angular\.json$/,
  /nest-cli\.json$/,
  /\.eslintrc/,
  /prettier/,
  /webpack/,
  /vite\.config/,
  /bunfig\.toml$/,
  /docker/i,
  /\.env\./,
];

export const ARCHITECTURAL_FILE_PATTERNS = [
  /\.module\.ts$/,
  /\.guard\.ts$/,
  /\.interceptor\.ts$/,
  /\.middleware\.ts$/,
  /\.pipe\.ts$/,
  /\.strategy\.ts$/,
  /\.gateway\.ts$/,
  /\.filter\.ts$/,
  /main\.ts$/,
  /app\.ts$/,
  /index\.ts$/,
];

/** Edits to documentation never count as fixing an error (D9). */
export const DOC_PATH_PATTERNS = [/\.(?:md|mdx|markdown)$/i, /(?:^|\/)docs\//];

export const GIT_RESTORE_PATTERNS = [
  /git\s+checkout\s+--?\s/,
  /git\s+restore\s/,
];

// A count of ZERO is not evidence: every passing bun run prints " 0 fail" and an
// all-failing one prints " 0 pass". Matching `\d+` read every passing bun run
// as a failure, so the TDD tracker (both targets) never reached GREEN.
export const TEST_FAIL_INDICATORS = [
  /\b[1-9]\d*\s+fail/i,
  /FAIL\s/,
  /tests?\s+failed/i,
  /\bAssertionError\b/,
  /expect\(.*\)\.(toBe|toEqual|toContain)/,
  /\btest\b.*\bfailed\b/i,
];

export const TEST_PASS_INDICATORS = [
  /\b[1-9]\d*\s+pass/i,
  /tests?\s+passed/i,
  /\ball\s+tests?\s+pass/i,
  /PASS\s/,
  /Tests:\s+\d+\s+passed/i,
];

// ─── Predicates & helpers ─────────────────────────────────────────────────────

/**
 * Whether a buffered event is an error: a known exit code decides; otherwise
 * a failed call, or output the classifier reads as an error.
 */
export function isErrorEvent(e: ToolEvent): boolean {
  if (typeof e.exitCode === "number") return e.exitCode !== 0;
  return !e.success || isErrorOutput(e.output);
}

export function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return ["write", "edit", "multiedit", "patch"].includes(name);
}

export function consume(e: ToolEvent, by: CaptureConsumer): void {
  if (!e.consumedBy?.includes(by)) e.consumedBy = [...(e.consumedBy ?? []), by];
}

export function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function compact<T>(arr: (T | undefined | null)[]): T[] {
  return arr.filter((v): v is T => v != null);
}

export function hasTestFailIndicator(text: string): boolean {
  return TEST_FAIL_INDICATORS.some((p) => p.test(text));
}

export function hasTestPassIndicator(text: string): boolean {
  return TEST_PASS_INDICATORS.some((p) => p.test(text));
}
