/**
 * Session Notifications — surface unread notifications at session start.
 *
 * Target-agnostic: consumed by the Claude Code SessionStart hook
 * (`session-start.ts`) and, via an injected reader, by the OpenCode plugin's
 * `session.created` handler. ⛔ Keep this module free of `bun:sqlite` (and of
 * anything that imports it) — it is bundled into the OpenCode plugin. Only
 * TYPE imports from the store are allowed.
 *
 * Rules (docs/plans/2026-09-23-signals-that-reach-nobody.md, Task 11):
 *   - Show this project's unread rows, plus NULL-project rows from an explicit
 *     allow-list of GLOBAL sources (sidecar version skew). Other NULL-project
 *     rows are pre-V13 history: excluded, never acted on.
 *   - Mark read ONLY the ids actually surfaced, one by one. Never
 *     `markAllNotificationsRead()` — it is global and would clear other
 *     projects' notifications and the dashboard badge.
 *   - Bounded (count + message length) and never throws.
 */

import type { Notification } from "../memory/types.js";
import { SKEW_NOTIFICATION_SOURCE } from "../sidecar/retire-notify.js";

/** NULL-project sources that are relevant to EVERY project. Keep narrow. */
export const GLOBAL_NOTIFICATION_SOURCES: readonly string[] = [
  SKEW_NOTIFICATION_SOURCE,
];

export const MAX_SESSION_NOTIFICATIONS = 5;
export const MAX_NOTIFICATION_MESSAGE_CHARS = 200;

/** Storage-side access, supplied by each target. */
export interface SessionNotificationReader {
  /**
   * Unread candidates for `projectPath` (a canonical identity) plus unread
   * global-source rows. May over-return — the selector re-applies the rules.
   */
  listCandidates(
    projectPath: string,
    limit: number,
  ): Notification[] | Promise<Notification[]>;
  /** Mark ONE notification read. */
  markRead(id: number): void | Promise<void>;
}

/** The two store reads a candidate query needs (structural, type-only). */
export interface SessionNotificationStore {
  getNotifications(opts: {
    unread?: boolean;
    projectPath?: string | null;
    limit?: number;
  }): Notification[];
  getUnreadGlobalNotifications(
    sources: readonly string[],
    limit: number,
  ): Notification[];
}

/**
 * The ONE candidate query, shared by the Claude Code hook (direct store) and
 * the sidecar's GET /notifications/session route (for the OpenCode plugin),
 * so the two targets cannot drift on which rows are eligible.
 * `projectPath` must already be a canonical identity.
 */
export function listSessionNotificationCandidates(
  store: SessionNotificationStore,
  projectPath: string,
  limit: number,
): Notification[] {
  return [
    ...store.getNotifications({ unread: true, projectPath, limit }),
    ...store.getUnreadGlobalNotifications(GLOBAL_NOTIFICATION_SOURCES, limit),
  ];
}

function isGlobal(n: Notification): boolean {
  return (
    (n.projectPath === null || n.projectPath === undefined) &&
    n.source !== null &&
    GLOBAL_NOTIFICATION_SOURCES.includes(n.source)
  );
}

/**
 * Pure filter: unread, and either this project's or an allow-listed global.
 * Newest first, capped at `MAX_SESSION_NOTIFICATIONS`.
 */
export function selectSessionNotifications(
  candidates: readonly Notification[],
  projectPath: string,
): Notification[] {
  return candidates
    .filter((n) => !n.read && (n.projectPath === projectPath || isGlobal(n)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SESSION_NOTIFICATIONS);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render the additionalContext digest, or null when there is nothing. */
export function formatNotificationDigest(
  notifications: readonly Notification[],
): string | null {
  if (notifications.length === 0) return null;
  const lines = notifications.map((n) => {
    const head = `- [${n.type}] ${truncate(n.title, MAX_NOTIFICATION_MESSAGE_CHARS)}`;
    return n.message
      ? `${head} — ${truncate(n.message, MAX_NOTIFICATION_MESSAGE_CHARS)}`
      : head;
  });
  return `Sentinal notifications (unread):\n${lines.join("\n")}`;
}

/**
 * Select, mark read (per id), and format. Only notifications whose mark-read
 * succeeded are shown, so shown ⇔ marked: nothing repeats, nothing is lost.
 * Never throws; null means "emit nothing".
 */
export async function surfaceSessionNotifications(
  reader: SessionNotificationReader,
  projectPath: string,
): Promise<string | null> {
  try {
    const candidates = await reader.listCandidates(
      projectPath,
      MAX_SESSION_NOTIFICATIONS,
    );
    const selected = selectSessionNotifications(candidates, projectPath);
    const shown: Notification[] = [];
    for (const n of selected) {
      try {
        await reader.markRead(n.id);
        shown.push(n);
      } catch {
        /* leave it unread for the next session */
      }
    }
    return formatNotificationDigest(shown);
  } catch {
    return null;
  }
}
