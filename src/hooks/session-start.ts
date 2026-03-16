/**
 * Session Start Hook
 *
 * Creates a session record in the SQLite database when a new session begins.
 * Detects the assistant type from the environment.
 * Auto-starts the dashboard server if not already running.
 *
 * Runs on: SessionStart (non-compact)
 */

import { readStdin, hint, output } from "../utils/hook-output.js";
import { MemoryStore } from "../memory/store.js";
import type { AssistantType } from "../memory/types.js";
import { autoStartDashboard } from "../dashboard/lifecycle.js";
import { detectSessionConflict } from "../session/conflict.js";

export function detectAssistant(): AssistantType {
  // CLAUDE_PLUGIN_ROOT is set when running within a Claude Code plugin
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return "opencode";
}

// Re-export for backwards compatibility with tests
export { autoStartDashboard } from "../dashboard/lifecycle.js";

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const store = new MemoryStore();

    store.insertSession({
      id: input.session_id,
      startTime: Date.now(),
      endTime: null,
      projectPath: input.cwd,
      assistant: detectAssistant(),
      summary: null,
      transcriptPath: input.transcript_path ?? null,
    });

    // Check for conflicting active sessions on the same project
    const conflict = detectSessionConflict(store, input.cwd, input.session_id);
    if (conflict) {
      output(hint("SessionStart", conflict.message));
    }

    store.close();

    // Auto-start dashboard if not running
    autoStartDashboard();
  } catch {
    // Non-fatal — session tracking is supplementary
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
