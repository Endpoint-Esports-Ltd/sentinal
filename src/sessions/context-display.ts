/**
 * Context Display Utilities
 *
 * Shared formatting functions for context usage visualization.
 * Used by both Claude Code hooks and OpenCode plugin.
 */

import type { ContextUsage } from "./context.js";

/**
 * Format a token count for display: e.g. 133000 → "~133k"
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `~${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/**
 * Render a visual context bar using block characters.
 *
 * Example: `Context: [▓▓▓▓▓▓▓▓░░░░░░░░░░░░] 80% | ~133k tokens`
 *
 * @param percent  Effective context usage (0-100)
 * @param tokens   Estimated token count
 * @param width    Bar width in characters (default 20)
 */
export function formatContextBar(
  percent: number,
  tokens: number,
  width = 20,
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = "▓".repeat(filled) + "░".repeat(empty);
  return `Context: [${bar}] ${percent}% | ${formatTokens(tokens)} tokens`;
}

/**
 * Get a context warning message based on effective usage.
 *
 * Stays SILENT until compaction is genuinely close — the monitor should only
 * speak when there is a valid pending compaction to warn about, not narrate
 * routine usage. Thresholds (on the compaction-adjusted effective percentage):
 *   90-94% — approaching: finish the current task before starting new work
 *   95%+   — imminent: complete the current task now
 *
 * Includes a visual context bar when a warning is triggered.
 */
export function getContextWarning(usage: ContextUsage): string | null {
  const { percent, tokens } = usage;
  const bar = formatContextBar(percent, tokens);

  if (percent >= 95)
    return `${bar}\nContext ~${percent}% effective — auto-compaction imminent. Complete the current task. Run /learn if this session has extractable knowledge.`;
  if (percent >= 90)
    return `${bar}\nContext ~${percent}% effective — approaching auto-compaction. Finish the current task before starting complex new work. Consider running /learn.`;
  return null;
}
