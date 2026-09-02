/**
 * Session End Hook
 *
 * Ends the session (sidecar-first, direct-store fallback), creates a
 * notification, auto-stops the dashboard server if no active sessions
 * remain, and cleans up the per-project event buffer.
 *
 * ⛔ Deliberately does NOT call `stopSidecarProcess` (review-mandated
 * carve-out, M10c): post-v1.36.2 H1 the sidecar owns its own lifecycle
 * via session-aware shutdown (including the sessions-never-seen
 * fallback). A hook-side stop is redundant and racy with other live
 * sessions. Pinned by `session-end.test.ts`.
 *
 * `processSessionEnd` is consumed by BOTH the standalone entry below and
 * the CLI dispatcher (`src/cli/commands/hook.ts`).
 */

import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStdin, type HookInput } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";
import { stopServer } from "../dashboard/lifecycle.js";

export async function processSessionEnd(input: HookInput): Promise<void> {
  try {
    const client = await SidecarClient.connect();
    if (client) {
      await client.endSession(input.session_id, { notification: true });
      const active = await client.getActiveSessions();
      if (active.length === 0) {
        stopServer();
      }
    } else {
      // Direct fallback (no sidecar running)
      const { MemoryStore } = await import("../memory/store.js");
      const store = new MemoryStore();
      store.endSession(input.session_id);
      store.insertNotification({
        type: "info",
        title: "Session ended",
        message: `Session ${input.session_id.slice(0, 8)} ended`,
        source: "session-end",
        sessionId: input.session_id,
      });
      const active = store.getActiveSessions();
      if (active.length === 0) {
        stopServer();
      }
      store.close();
    }
  } catch {
    // Non-fatal — session may not have been started
  }

  // Clean up event buffer (no longer needed after session ends)
  try {
    const bufferPath = join(input.cwd, ".sentinal", "event-buffer.json");
    if (existsSync(bufferPath)) {
      unlinkSync(bufferPath);
    }
  } catch {
    // Non-fatal cleanup (including empty input with no cwd)
  }
}

async function main(): Promise<void> {
  await processSessionEnd(await readStdin());
}

if (import.meta.main) {
  main().catch(() => {});
}
