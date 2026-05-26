/**
 * FileChanged Hook (Claude Code)
 *
 * FileChanged hook that invalidates TDD tracker state when test files are
 * modified externally (outside of the AI's own edits).
 *
 * Behavior:
 *   - If file_path ends with .test.ts or .spec.ts → clear TDD state via sidecar
 *   - Otherwise → no-op
 *
 * This hook is fire-and-forget (async, non-blocking). Errors are swallowed.
 */

import { readStdin } from "../utils/hook-output.js";
import type { HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if the file path is a test file (.test.ts or .spec.ts). */
function isTestFilePath(filePath: string): boolean {
  return filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts");
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Process a FileChanged hook event.
 *
 * If the changed file is a test file, clears any TDD state associated with
 * that file via the sidecar. If the sidecar is unavailable, silently no-ops.
 */
export async function processFileChanged(input: HookInput): Promise<void> {
  const filePath = input.file_path;

  // No file path or not a test file — nothing to do
  if (!filePath || !isTestFilePath(filePath)) {
    return;
  }

  // Attempt to connect to sidecar and clear TDD state
  try {
    const client = await SidecarClient.connect();
    if (!client) return;
    await client.clearTddState(filePath);
  } catch {
    // Non-fatal — sidecar unavailable or clear failed
  }
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdin();
  try {
    await processFileChanged(input);
  } catch {
    // FileChanged hook failure is non-fatal
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
