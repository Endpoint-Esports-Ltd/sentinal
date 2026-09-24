/**
 * Session Start Hook
 *
 * Creates a session record in the SQLite database when a new session begins.
 * Detects the assistant type from the environment.
 * Auto-starts the dashboard server if not already running.
 * Surfaces unread notifications for this project (plus global skew signals).
 *
 * Runs on: SessionStart (non-compact). ⚠️ The LIVE entry point is the CLI
 * dispatcher (`src/cli/commands/hook.ts` runSessionStart); `main()` below is
 * for standalone/debug use. Both call `processSessionStartNotifications`.
 */

import {
  readStdin,
  hint,
  output,
  type HookInput,
} from "../utils/hook-output.js";
import { MemoryStore } from "../memory/store.js";
import type { AssistantType } from "../memory/types.js";
import { autoStartDashboard } from "../dashboard/lifecycle.js";
import { detectSessionConflict } from "../session/conflict.js";
import { resolveProjectIdentity } from "../project/identity.js";
import {
  listSessionNotificationCandidates,
  surfaceSessionNotifications,
} from "./session-notifications.js";

export function detectAssistant(): AssistantType {
  // CLAUDE_PLUGIN_ROOT is set when running within a Claude Code plugin
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return "opencode";
}

// Re-export for backwards compatibility with tests
export { autoStartDashboard } from "../dashboard/lifecycle.js";

/**
 * Read + mark-read (per id) this project's unread notifications and return
 * the digest for `additionalContext`, or null. Reads the store DIRECTLY: the
 * sidecar has no notification-read route, and `MemoryStore` opens without
 * sqlite-vec. Never throws.
 */
export async function processSessionStartNotifications(
  cwd: string,
  opts: { dbPath?: string } = {},
): Promise<string | null> {
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(opts.dbPath);
    const s = store;
    return await surfaceSessionNotifications(
      {
        listCandidates: (projectPath, limit) =>
          listSessionNotificationCandidates(s, projectPath, limit),
        markRead: (id) => s.markNotificationRead(id),
      },
      resolveProjectIdentity(cwd),
    );
  } catch {
    return null;
  } finally {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Side-effecting collaborators of the dispatcher body, injectable for tests. */
export interface SessionStartDeps {
  version?: string;
  autoStartSidecar: () => void;
  autoStartDashboard: (version?: string) => Promise<void> | void;
  connectSidecar: () => Promise<{
    createSession(opts: {
      id: string;
      projectPath: string;
      assistant: string;
      transcriptPath?: string | null;
    }): Promise<unknown>;
  } | null>;
  openStore?: () => MemoryStore;
  notifications?: (cwd: string) => Promise<string | null>;
  emit?: (context: string) => void;
}

/**
 * The LIVE SessionStart body (called by `sentinal hook shared session-start`):
 * autostart, record the session (sidecar first, direct store fallback), then
 * surface notifications. Never throws.
 */
export async function processSessionStart(
  input: HookInput,
  deps: SessionStartDeps,
): Promise<void> {
  const assistant = detectAssistant();
  const openStore = deps.openStore ?? (() => new MemoryStore());
  const notifications = deps.notifications ?? processSessionStartNotifications;
  const emit = deps.emit ?? ((c: string) => output(hint("SessionStart", c)));

  try {
    deps.autoStartSidecar();
    await deps.autoStartDashboard(deps.version);
  } catch {
    /* non-fatal */
  }

  const session = {
    id: input.session_id,
    projectPath: input.cwd,
    assistant,
    transcriptPath: input.transcript_path ?? null,
  };
  let recorded = false;
  try {
    const client = await deps.connectSidecar();
    if (client) {
      await client.createSession(session);
      recorded = true;
    }
  } catch {
    /* fall back to direct */
  }
  if (!recorded) {
    try {
      const store = openStore();
      store.insertSession({
        ...session,
        startTime: Date.now(),
        endTime: null,
        summary: null,
      });
      store.close();
    } catch {
      /* non-fatal — session tracking is supplementary */
    }
  }

  try {
    const digest = await notifications(input.cwd);
    if (digest) emit(digest);
  } catch {
    /* never block session start */
  }
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
      transcriptPath: input.transcript_path ?? null,
    });

    // Check for conflicting active sessions on the same project
    const conflict = detectSessionConflict(store, input.cwd, input.session_id);
    store.close();

    const digest = await processSessionStartNotifications(input.cwd);
    const context = [conflict?.message, digest].filter(Boolean).join("\n\n");
    if (context) {
      output(hint("SessionStart", context));
    }

    // Auto-start dashboard if not running
    autoStartDashboard();
  } catch {
    // Non-fatal — session tracking is supplementary
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
