/**
 * Session End Hook
 *
 * Ends the session in SQLite, creates a notification, and auto-stops
 * the dashboard server if no active sessions remain.
 */

import { readStdin } from "../utils/hook-output.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { stopServer } from "../dashboard/lifecycle.js";

async function main(): Promise<void> {
  const input = await readStdin();

  try {
    const store = new MemoryStore();

    // End session in SQLite
    store.endSession(input.session_id);

    // Create session-end notification
    store.insertNotification({
      type: "info",
      title: "Session ended",
      message: `Session ${input.session_id.slice(0, 8)} ended`,
      source: "session-end",
      sessionId: input.session_id,
    });

    // Auto-stop dashboard if no active sessions remain
    const active = store.getActiveSessions();
    if (active.length === 0) {
      stopServer();
    }

    store.close();
  } catch {
    // Non-fatal — session may not have been started
  }

  // Clean up event buffer (no longer needed after session ends)
  const bufferPath = join(input.cwd, ".sentinal", "event-buffer.json");
  try {
    if (existsSync(bufferPath)) {
      unlinkSync(bufferPath);
    }
  } catch {
    // Non-fatal cleanup
  }
}
main().catch(() => {});
