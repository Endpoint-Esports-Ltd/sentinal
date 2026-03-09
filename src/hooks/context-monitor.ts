import { readStdin, hint, output } from "../utils/hook-output.js";
import { estimateContextUsage } from "../sessions/context.js";

/**
 * Get a context warning message based on effective usage percentage.
 * Thresholds: 80% (info), 90% (warning), 95%+ (urgent).
 */
export function getContextWarning(effectivePercent: number): string | null {
  if (effectivePercent >= 95) return `Context ~${effectivePercent}% effective. Complete current task — auto-compaction imminent. Run /learn if this session has extractable knowledge.`;
  if (effectivePercent >= 90) return `Context ~${effectivePercent}% effective. Complete current work, don't start complex new tasks. Consider running /learn.`;
  if (effectivePercent >= 80) return `Context ~${effectivePercent}% effective. Work normally — auto-compaction handles the rest. Consider running /learn if valuable.`;
  return null;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const usage = estimateContextUsage(input.transcript_path);
    const warning = getContextWarning(usage.percent);
    if (warning) output(hint("PostToolUse", warning));
  } catch { return; }
}
if (import.meta.main) {
  main().catch(() => {});
}
