/**
 * Capture detectors — the individual heuristics `analyzeEvent` (capture.ts)
 * chains in priority order, plus the observation-content builders.
 *
 * ⛔ Bundled into the OpenCode plugin via `capture.ts` — keep imports local.
 */

import { isErrorOutput } from "./error-classifier.js";
import type { EventBuffer } from "./capture-buffer.js";
import {
  ARCHITECTURAL_FILE_PATTERNS,
  CONFIG_FILE_PATTERNS,
  DOC_PATH_PATTERNS,
  GIT_RESTORE_PATTERNS,
  basename,
  compact,
  consume,
  hasTestFailIndicator,
  hasTestPassIndicator,
  isEditTool,
  isErrorEvent,
  type CaptureDecision,
  type ToolEvent,
} from "./capture-patterns.js";

/** Detect error followed by a successful edit (error → fix pattern) */
export function detectErrorFixSequence(
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
export function detectConfigChange(event: ToolEvent): CaptureDecision | null {
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
export function detectArchitecturalChange(
  event: ToolEvent,
): CaptureDecision | null {
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
export function detectBuildFixSequence(
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
export function detectTddCycle(
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

// ─── Failed Approach Detection ────────────────────────────────────────────────

/**
 * Detect failed approaches:
 * Signal 1: 3+ error events on the same filePath with no success between them
 * Signal 2: git restore/checkout on a recently edited file
 */
export function detectFailedApproach(
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

export function noCaptureDecision(): CaptureDecision {
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

// ─── Content builders ─────────────────────────────────────────────────────────

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
