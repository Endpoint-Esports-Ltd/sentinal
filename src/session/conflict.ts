/**
 * Session Conflict Detection
 *
 * Detects when multiple AI sessions are active on the same project,
 * warning users about potential editing conflicts.
 */

import type { MemoryStore } from "../memory/store.js";
import type { Session } from "../memory/types.js";
import { resolveProjectIdentity } from "../project/identity.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionConflict {
  conflictingSessions: Session[];
  message: string;
}

export interface FileConflict {
  sessionId: string;
  lastEditAt: number;
  message: string;
}

// ─── Session-Level Conflict ───────────────────────────────────────────────────

/**
 * Check for active sessions on the same project (excluding the current one).
 * Returns conflict info with a warning message, or null if no conflicts.
 *
 * `projectPath` is a STORAGE KEY and is canonicalized here, at the entry point.
 * Callers hand it a hook's raw `cwd` (`src/hooks/session-start.ts:42`), which
 * from a linked worktree is the worktree path, while `sessions.project_path`
 * holds the canonical main-checkout key. `listSessions` filters with exact
 * equality, so without this the detector reported "no conflict" unconditionally
 * from every worktree.
 */
export function detectSessionConflict(
  store: MemoryStore,
  projectPath: string,
  currentSessionId: string,
): SessionConflict | null {
  const activeSessions = store.listSessions({
    project: resolveProjectIdentity(projectPath),
    active: true,
  });

  const others = activeSessions.filter((s) => s.id !== currentSessionId);
  if (others.length === 0) return null;

  const descriptions = others.map((s) => {
    const started = new Date(s.startTime).toLocaleTimeString();
    return `${s.id} (${s.assistant}, started ${started})`;
  });

  const message = `[Sentinal] Warning: ${others.length} other active session(s) on this project:\n${descriptions.map((d) => `  - ${d}`).join("\n")}\nEdits may conflict. Coordinate or close stale sessions.`;

  return { conflictingSessions: others, message };
}

// ─── File-Level Conflict ──────────────────────────────────────────────────────

const RECENCY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if another active session recently edited the same file.
 * Uses a direct SQL query on observations + sessions for performance.
 * Returns conflict info or null if no file conflicts.
 *
 * ⛔ The two path parameters are DIFFERENT KINDS and are treated differently:
 *   - `projectPath` is a STORAGE KEY (`o.project_path = ?`, exact equality) and
 *     is canonicalized, for the same reason as `detectSessionConflict` above.
 *     Its caller (`src/cli/commands/hook.ts:200`) passes the hook's raw `cwd`.
 *   - `filePath` is a FILE path matched with `LIKE '%…%'` against
 *     `o.file_paths`. It is deliberately left RAW — canonicalizing it would
 *     resolve a relative path against the wrong root, and a repo-root result
 *     would make the LIKE match every observation in the project.
 */
export function detectFileConflict(
  store: MemoryStore,
  filePath: string,
  projectPath: string,
  currentSessionId: string,
): FileConflict | null {
  const db = store.getRawDb();
  const cutoff = Date.now() - RECENCY_WINDOW_MS;
  const filePattern = `%${filePath}%`;
  const projectKey = resolveProjectIdentity(projectPath);

  // Find observations from other active sessions that mention this file
  const row = db
    .prepare(
      `
    SELECT o.session_id, o.timestamp
    FROM observations o
    INNER JOIN sessions s ON o.session_id = s.id
    WHERE o.project_path = ?
      AND o.file_paths LIKE ?
      AND o.session_id != ?
      AND o.timestamp > ?
      AND s.end_time IS NULL
    ORDER BY o.timestamp DESC
    LIMIT 1
  `,
    )
    .get(projectKey, filePattern, currentSessionId, cutoff) as {
    session_id: string;
    timestamp: number;
  } | null;

  if (!row) return null;

  const basename = filePath.split("/").pop() ?? filePath;
  return {
    sessionId: row.session_id,
    lastEditAt: row.timestamp,
    message: `[Sentinal] Warning: ${basename} was recently edited by another active session (${row.session_id}).`,
  };
}
