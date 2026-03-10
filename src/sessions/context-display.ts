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
 * Thresholds: 80% (info), 90% (warning), 95%+ (urgent).
 * Includes a visual context bar when a warning is triggered.
 */
export function getContextWarning(usage: ContextUsage): string | null {
  const { percent, tokens } = usage;
  const bar = formatContextBar(percent, tokens);

  if (percent >= 95)
    return `${bar}\nContext ~${percent}% effective. Complete current task — auto-compaction imminent. Run /learn if this session has extractable knowledge.`;
  if (percent >= 90)
    return `${bar}\nContext ~${percent}% effective. Complete current work, don't start complex new tasks. Consider running /learn.`;
  if (percent >= 80)
    return `${bar}\nContext ~${percent}% effective. Work normally — auto-compaction handles the rest. Consider running /learn if valuable.`;
  return null;
}
