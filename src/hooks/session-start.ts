/**
 * Session Start Hook
 *
 * Creates a session record in the SQLite database when a new session begins.
 * Detects the assistant type from the environment.
 *
 * Runs on: SessionStart (non-compact)
 */

import { readStdin } from "../utils/hook-output.js";
import { MemoryStore } from "../memory/store.js";
import type { AssistantType } from "../memory/types.js";

function detectAssistant(): AssistantType {
  // CLAUDE_PLUGIN_ROOT is set when running within a Claude Code plugin
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return "opencode";
}

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
    });

    store.close();
  } catch {
    // Non-fatal — session tracking is supplementary
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
