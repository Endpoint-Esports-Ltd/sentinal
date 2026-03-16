/**
 * Session Conflict Detection
 *
 * Detects when multiple AI sessions are active on the same project,
 * warning users about potential editing conflicts.
 */

import type { MemoryStore } from "../memory/store.js";
import type { Session } from "../memory/types.js";
import type { Database } from "bun:sqlite";

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
 */
export function detectSessionConflict(
  store: MemoryStore,
  projectPath: string,
  currentSessionId: string,
): SessionConflict | null {
  const activeSessions = store.listSessions({
    project: projectPath,
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

  // Find observations from other active sessions that mention this file
  const row = db.prepare(`
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
  `).get(projectPath, filePattern, currentSessionId, cutoff) as { session_id: string; timestamp: number } | null;

  if (!row) return null;

  const basename = filePath.split("/").pop() ?? filePath;
  return {
    sessionId: row.session_id,
    lastEditAt: row.timestamp,
    message: `[Sentinal] Warning: ${basename} was recently edited by another active session (${row.session_id}).`,
  };
}
