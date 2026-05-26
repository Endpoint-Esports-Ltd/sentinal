/**
 * TaskCreated Hook (Claude Code)
 *
 * Async PostToolUse hook that fires when Claude Code creates a background task.
 * Inserts a dashboard notification so the user can see the task subject.
 *
 * This hook is fire-and-forget (async: true in hooks.json) — it never blocks.
 */

import { readStdin } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

// ─── Core Logic ───────────────────────────────────────────────────────────────

export async function processTaskCreated(input: HookInput): Promise<void> {
  const client = await SidecarClient.connect();
  if (!client) return;

  const title = `Task: ${input.task_subject ?? input.task_id ?? "unknown"}`;
  const message = input.task_description;

  await client.insertNotification({ type: "info", title, message });
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdin();
  try {
    await processTaskCreated(input);
  } catch {
    // Fire-and-forget — errors are non-fatal
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
