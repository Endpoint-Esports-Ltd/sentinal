/**
 * Capture Heuristics
 *
 * Detects "learning moments" from tool use events and determines whether
 * an observation should be captured. Used by both Claude Code hooks and
 * OpenCode plugin.
 *
 * Capture triggers (from plan):
 * - Error-fix sequence (error log followed by successful edit)
 * - Significant file changes (new module, architectural file)
 * - TDD cycle completion (test fail → implementation → test pass)
 * - Build/lint fix sequences
 * - Configuration changes
 *
 * The capture module does NOT interact with the database directly.
 * It only analyzes events and returns capture decisions.
 */

import type { ObservationType } from "./types.js";
import { isErrorOutput } from "./error-classifier.js";

export { isErrorOutput, isPassingTestSummary } from "./error-classifier.js";

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

const CONFIG_FILE_PATTERNS = [
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

const ARCHITECTURAL_FILE_PATTERNS = [
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
const DOC_PATH_PATTERNS = [/\.(?:md|mdx|markdown)$/i, /(?:^|\/)docs\//];

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

// ─── Event Buffer ─────────────────────────────────────────────────────────────

export interface ErrorWindowOptions {
  /** The event being analysed — excluded from its own window. */
  exclude?: ToolEvent;
  /** Whose consumption to honour (default "fix"). */
  consumer?: CaptureConsumer;
}

/**
 * Sliding window of recent tool events for pattern detection.
 * Maintains the last N events per session to detect sequences
 * like error → fix.
 */
export class EventBuffer {
  private events: ToolEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 20) {
    this.maxSize = maxSize;
  }

  push(event: ToolEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  /**
   * Get recent events (most recent first). `exclude` drops the event being
   * analysed — callers push it before analysing, and it is never its own
   * predecessor.
   */
  recent(count: number = 5, exclude?: ToolEvent): ToolEvent[] {
    const pool = exclude
      ? this.events.filter((e) => e !== exclude)
      : this.events;
    return pool.slice(-count).reverse();
  }

  /**
   * Unconsumed errors among the last `windowSize` PRIOR events, most recent
   * first. `consumer` (default "fix") selects whose consumption is honoured.
   */
  recentErrors(
    windowSize: number = 3,
    opts: ErrorWindowOptions = {},
  ): ToolEvent[] {
    const consumer = opts.consumer ?? "fix";
    return this.recent(windowSize, opts.exclude).filter(
      (e) => isErrorEvent(e) && !e.consumedBy?.includes(consumer),
    );
  }

  /** The most recent unconsumed error in the window, or null. */
  hasRecentError(
    windowSize: number = 3,
    opts: ErrorWindowOptions = {},
  ): ToolEvent | null {
    return this.recentErrors(windowSize, opts)[0] ?? null;
  }

  clear(): void {
    this.events = [];
  }

  get size(): number {
    return this.events.length;
  }
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

/**
 * Analyze a tool event and decide whether to capture an observation.
 * Uses the event buffer to detect patterns (e.g., error → fix sequences).
 */
export function analyzeEvent(
  event: ToolEvent,
  buffer: EventBuffer,
): CaptureDecision {
  // Check each heuristic in order of priority
  const decision =
    detectErrorFixSequence(event, buffer) ??
    detectTddCycle(event, buffer) ??
    detectConfigChange(event) ??
    detectArchitecturalChange(event) ??
    detectBuildFixSequence(event, buffer) ??
    detectFailedApproach(event, buffer);

  return decision ?? noCaptureDecision();
}

/** Detect error followed by a successful edit (error → fix pattern) */
function detectErrorFixSequence(
  event: ToolEvent,
  buffer: EventBuffer,
): CaptureDecision | null {
  if (!isEditTool(event.toolName) || !event.success || !event.filePath)
    return null;
  // A doc edit neither fixes the error nor consumes it.
  if (DOC_PATH_PATTERNS.some((p) => p.test(event.filePath!))) return null;

  const errors = buffer.recentErrors(5, { exclude: event, consumer: "fix" });
  const recentError = errors[0];
  if (!recentError) return null;
  // The whole error streak is answered by this one fix.
  for (const e of errors) consume(e, "fix");

  return {
    shouldCapture: true,
    type: "fix",
    title: `Fixed issue in ${basename(event.filePath)}`,
    content: buildFixContent(recentError, event),
    filePaths: compact([recentError.filePath, event.filePath]),
    tags: ["fix", "auto-captured"],
    confidence: 0.7,
  };
}

/** Detect changes to configuration files */
function detectConfigChange(event: ToolEvent): CaptureDecision | null {
  if (!isEditTool(event.toolName) || !event.success || !event.filePath)
    return null;

  if (!CONFIG_FILE_PATTERNS.some((p) => p.test(event.filePath!))) return null;

  return {
    shouldCapture: true,
    type: "decision",
    title: `Configuration change: ${basename(event.filePath)}`,
    content: `Modified configuration file ${event.filePath}`,
    filePaths: [event.filePath],
    tags: ["config", "auto-captured"],
    confidence: 0.65,
  };
}

/** Detect changes to architectural files (modules, guards, etc.) */
function detectArchitecturalChange(event: ToolEvent): CaptureDecision | null {
  if (!isEditTool(event.toolName) || !event.success || !event.filePath)
    return null;

  // Only trigger for Write (new file creation), not Edit
  if (event.toolName.toLowerCase() !== "write") return null;

  if (!ARCHITECTURAL_FILE_PATTERNS.some((p) => p.test(event.filePath!)))
    return null;

  return {
    shouldCapture: true,
    type: "discovery",
    title: `New architectural file: ${basename(event.filePath)}`,
    content: `Created new architectural file ${event.filePath}`,
    filePaths: [event.filePath],
    tags: ["architecture", "auto-captured"],
    confidence: 0.7,
  };
}

/** Detect build/lint error followed by successful build/lint */
function detectBuildFixSequence(
  event: ToolEvent,
  buffer: EventBuffer,
): CaptureDecision | null {
  if (event.toolName.toLowerCase() !== "bash" || !event.success) return null;
  if (!event.output) return null;

  // Check if this looks like a successful build/lint
  const isBuildSuccess =
    /\b(compiled|built|passed|success)\b/i.test(event.output) &&
    !isErrorOutput(event.output, event.exitCode);
  if (!isBuildSuccess) return null;

  // Check if a recent Bash event had errors
  const recentError = buffer.hasRecentError(3, {
    exclude: event,
    consumer: "build",
  });
  if (!recentError || recentError.toolName.toLowerCase() !== "bash")
    return null;
  consume(recentError, "build");

  return {
    shouldCapture: true,
    type: "fix",
    title: "Build/lint issue resolved",
    content: buildFixContent(recentError, event),
    filePaths: compact([recentError.filePath, event.filePath]),
    tags: ["build", "fix", "auto-captured"],
    confidence: 0.65,
  };
}

/** Detect TDD cycle: test fail → edit(s) → test pass */
function detectTddCycle(
  event: ToolEvent,
  buffer: EventBuffer,
): CaptureDecision | null {
  // Only triggers on a successful Bash command that looks like test pass
  if (event.toolName.toLowerCase() !== "bash" || !event.success) return null;
  if (!event.output || !hasTestPassIndicator(event.output)) return null;

  // Look backward for a test failure, with edits in between
  const recent = buffer.recent(10, event);
  let testFailEvent: ToolEvent | null = null;
  let hasEditBetween = false;

  for (const prev of recent) {
    if (isEditTool(prev.toolName) && prev.success) {
      hasEditBetween = true;
    }
    if (
      prev.toolName.toLowerCase() === "bash" &&
      prev.output &&
      prev.exitCode !== 0 &&
      hasTestFailIndicator(prev.output)
    ) {
      testFailEvent = prev;
      break;
    }
  }

  // A failure whose cycle was already captured closes the search.
  if (!testFailEvent || !hasEditBetween) return null;
  if (testFailEvent.consumedBy?.includes("tdd")) return null;
  consume(testFailEvent, "tdd");

  // Collect file paths from edits between the fail and pass
  const editPaths: string[] = [];
  for (const prev of recent) {
    if (prev === testFailEvent) break;
    if (isEditTool(prev.toolName) && prev.filePath) {
      editPaths.push(prev.filePath);
    }
  }

  return {
    shouldCapture: true,
    type: "fix",
    title: `TDD cycle completed: ${editPaths.length > 0 ? basename(editPaths[0]) : "implementation fixed"}`,
    content: buildTddContent(testFailEvent, event, editPaths),
    filePaths: compact(editPaths),
    tags: ["tdd", "test", "fix", "auto-captured"],
    confidence: 0.75,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Failed Approach Detection ────────────────────────────────────────────────

const GIT_RESTORE_PATTERNS = [/git\s+checkout\s+--?\s/, /git\s+restore\s/];

/**
 * Detect failed approaches:
 * Signal 1: 3+ error events on the same filePath with no success between them
 * Signal 2: git restore/checkout on a recently edited file
 */
function detectFailedApproach(
  event: ToolEvent,
  buffer: EventBuffer,
): CaptureDecision | null {
  // Signal 2: git restore/checkout in bash output
  if (event.toolName.toLowerCase() === "bash" && event.output) {
    for (const pattern of GIT_RESTORE_PATTERNS) {
      if (pattern.test(event.output)) {
        // Check if any recently edited file was restored
        const recentEdits = buffer
          .recent(10)
          .filter((e) => isEditTool(e.toolName) && e.filePath);
        const editedFiles = new Set(recentEdits.map((e) => e.filePath));
        // Check if the git restore targets a recently edited file
        const restoredFile = [...editedFiles].find(
          (fp) => fp && event.output!.includes(basename(fp)),
        );
        if (restoredFile) {
          return {
            shouldCapture: true,
            type: "pattern",
            title: `Failed approach: reverted ${basename(restoredFile)}`,
            content: `Approach was abandoned — file was edited then reverted via git restore/checkout. Output: ${event.output.slice(0, 200)}`,
            filePaths: compact([restoredFile]),
            tags: ["failed-approach", "auto-captured"],
            confidence: 0.6,
          };
        }
      }
    }
  }

  // Signal 1: 3+ errors on same file — trigger on the error event itself
  if (!event.success && event.filePath) {
    const recent = buffer.recent(10, event);
    let errorCount = 1; // Count current event
    for (const e of recent) {
      if (e.filePath !== event.filePath) continue;
      if (isErrorEvent(e)) {
        errorCount++;
      } else if (e.success && e.toolName.toLowerCase() === "bash") {
        // A successful bash run on the same file breaks the error streak
        break;
      }
    }
    if (errorCount >= 3) {
      return {
        shouldCapture: true,
        type: "pattern",
        title: `Failed approach: repeated errors on ${basename(event.filePath)}`,
        content: `${errorCount} errors detected on ${event.filePath} without successful resolution. The current approach may not be working.`,
        filePaths: [event.filePath],
        tags: ["failed-approach", "auto-captured"],
        confidence: 0.6,
      };
    }
  }

  return null;
}

function noCaptureDecision(): CaptureDecision {
  return {
    shouldCapture: false,
    type: "discovery",
    title: "",
    content: "",
    filePaths: [],
    tags: [],
    confidence: 0,
  };
}

function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return ["write", "edit", "multiedit", "patch"].includes(name);
}

/**
 * Whether a buffered event is an error: a known exit code decides; otherwise
 * a failed call, or output the classifier reads as an error.
 */
export function isErrorEvent(e: ToolEvent): boolean {
  if (typeof e.exitCode === "number") return e.exitCode !== 0;
  return !e.success || isErrorOutput(e.output);
}

function consume(e: ToolEvent, by: CaptureConsumer): void {
  if (!e.consumedBy?.includes(by)) e.consumedBy = [...(e.consumedBy ?? []), by];
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function compact<T>(arr: (T | undefined | null)[]): T[] {
  return arr.filter((v): v is T => v != null);
}

function hasTestFailIndicator(text: string): boolean {
  return TEST_FAIL_INDICATORS.some((p) => p.test(text));
}

function hasTestPassIndicator(text: string): boolean {
  return TEST_PASS_INDICATORS.some((p) => p.test(text));
}

function buildTddContent(
  failEvent: ToolEvent,
  passEvent: ToolEvent,
  editPaths: string[],
): string {
  const lines: string[] = [];

  if (failEvent.output) {
    const snippet = failEvent.output.slice(0, 400);
    lines.push(`**Test failure:** ${snippet}`);
  }

  if (editPaths.length > 0) {
    lines.push(`**Files modified:** ${editPaths.join(", ")}`);
  }

  if (passEvent.output) {
    const snippet = passEvent.output.slice(0, 300);
    lines.push(`**Tests passing:** ${snippet}`);
  }

  return (
    lines.join("\n\n") ||
    "TDD cycle: tests failed, implementation fixed, tests passing."
  );
}

function buildFixContent(errorEvent: ToolEvent, fixEvent: ToolEvent): string {
  const lines: string[] = [];

  if (errorEvent.output) {
    const errorSnippet = errorEvent.output.slice(0, 500);
    lines.push(`**Error:** ${errorSnippet}`);
  }

  if (fixEvent.filePath) {
    lines.push(`**Fixed in:** ${fixEvent.filePath}`);
  }

  if (fixEvent.output) {
    const fixSnippet = fixEvent.output.slice(0, 300);
    lines.push(`**Result:** ${fixSnippet}`);
  }

  return lines.join("\n\n") || "Error detected and subsequently fixed.";
}
