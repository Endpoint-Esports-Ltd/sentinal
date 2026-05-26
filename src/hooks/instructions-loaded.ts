/**
 * Instructions Loaded Hook (Claude Code)
 *
 * Fires on the InstructionsLoaded event to record which rules/instructions
 * files were loaded per session. Powers /sync decisions.
 *
 * Only captures when load_reason is "session_start" or "path_glob_match".
 * All other reasons (nested_traversal, include, compact) are skipped.
 *
 * This hook is async (fire-and-forget). Sidecar preferred; silent no-op
 * if unavailable.
 */

import { basename } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

/** Load reasons that warrant capturing an observation. */
const CAPTURE_REASONS = new Set(["session_start", "path_glob_match"]);

/**
 * Process an InstructionsLoaded hook event.
 * Records which instructions file was loaded as a memory observation.
 */
export async function processInstructionsLoaded(
  input: HookInput,
): Promise<void> {
  const { load_reason, file_path, memory_type, cwd, session_id } = input;

  // Only capture for relevant load reasons
  if (!load_reason || !CAPTURE_REASONS.has(load_reason)) {
    return;
  }

  if (!file_path) {
    return;
  }

  // Try sidecar — silent no-op if unavailable
  try {
    const client = await SidecarClient.connect();
    if (!client) return;

    await client.addObservation({
      sessionId: session_id,
      projectPath: cwd,
      type: "discovery",
      title: `Instructions loaded: ${basename(file_path)}`,
      content: `File: ${file_path}\nMemory type: ${memory_type ?? "unknown"}\nLoad reason: ${load_reason}`,
      tags: ["instructions", "rules", load_reason],
    });
  } catch {
    // Sidecar failure is non-fatal for async hooks
  }
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    await processInstructionsLoaded(input);
  } catch {
    // Non-fatal — async hooks cannot block
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
