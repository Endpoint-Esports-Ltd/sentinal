import { readStdin, hint, output } from "../utils/hook-output.js";
import { estimateContextUsage } from "../sessions/context.js";
import { getContextWarning } from "../sessions/context-display.js";

// Re-export shared functions for backwards compatibility with tests
export {
  formatTokens,
  formatContextBar,
  getContextWarning,
} from "../sessions/context-display.js";

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const usage = estimateContextUsage(input.transcript_path);
    const warning = getContextWarning(usage);
    if (warning) output(hint("PostToolUse", warning));
  } catch {
    return;
  }
}
if (import.meta.main) {
  main().catch(() => {});
}
