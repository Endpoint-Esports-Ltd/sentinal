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
 *
 * Split for length: types/patterns/predicates live in `capture-patterns.ts`,
 * the `EventBuffer` in `capture-buffer.ts`, the heuristics in
 * `capture-detectors.ts`. This module re-exports the public surface — the
 * OpenCode plugin and `src/index.ts` import from here, so keep it that way.
 * ⛔ None of these modules may import zod, `bun:sqlite` or the memory store:
 * the plugin bundles them.
 */

import type { EventBuffer } from "./capture-buffer.js";
import type { CaptureDecision, ToolEvent } from "./capture-patterns.js";
import {
  detectArchitecturalChange,
  detectBuildFixSequence,
  detectConfigChange,
  detectErrorFixSequence,
  detectFailedApproach,
  detectTddCycle,
  noCaptureDecision,
} from "./capture-detectors.js";

export { isErrorOutput, isPassingTestSummary } from "./error-classifier.js";
export {
  MIN_CAPTURE_CONFIDENCE,
  TEST_FAIL_INDICATORS,
  TEST_PASS_INDICATORS,
} from "./capture-patterns.js";
export type {
  CaptureConsumer,
  CaptureDecision,
  ToolEvent,
} from "./capture-patterns.js";
export { EventBuffer } from "./capture-buffer.js";
export type { ErrorWindowOptions } from "./capture-buffer.js";

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
