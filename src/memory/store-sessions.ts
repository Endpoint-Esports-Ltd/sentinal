/**
 * Memory Store — sessions + notifications
 *
 * The session and notification half of `MemoryStore`, split out of
 * `store.ts` purely for file length (Task 6a of
 * docs/plans/2026-09-01-audit-high-remediation.md). `MemoryStore` extends
 * this (via `MemoryStoreObservations`), so callers still see a single class
 * with every method on it — same inverted-inheritance precedent as
 * `src/sidecar/client-routes.ts`.
 *
 * This file is only ever imported by `store.ts`; it is not part of the
 * public API surface.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  Session,
  ListSessionsOptions,
  RawSession,
  Notification,
  NotificationType,
  RawNotification,
} from "./types.js";
import {
  STALE_SESSION_THRESHOLD_MS,
  SESSION_LIVENESS_WINDOW_MS,
} from "./types.js";

export abstract class MemoryStoreSessions {
  // Assigned by the `MemoryStore` constructor (the only concrete subclass).
  protected db!: Database;
  protected dbPath!: string;

  // ─── Sessions ─────────────────────────────────────────────────────────

  insertSession(
    session: Omit<Session, "observationCount" | "lastActive">,
  ): Session {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, start_time, end_time, project_path, assistant, summary, transcript_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.startTime,
        session.endTime,
        session.projectPath,
        session.assistant,
        session.summary,
        session.transcriptPath,
      );

    return this.getSession(session.id)!;
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as RawSession | null;
    return row ? this.deserializeSession(row) : null;
  }

  endSession(id: string, summary?: string): void {
    const obsCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM observations WHERE session_id = ?",
      )
      .get(id) as { count: number };

    this.db
      .prepare(
        `UPDATE sessions SET end_time = ?, summary = ?, observation_count = ? WHERE id = ?`,
      )
      .run(Date.now(), summary ?? null, obsCount.count, id);
  }

  getActiveSessions(): Session[] {
    return this.listSessions({ active: true });
  }

  listSessions(opts: ListSessionsOptions = {}): Session[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.active === true) clauses.push("end_time IS NULL");
    else if (opts.active === false) clauses.push("end_time IS NOT NULL");
    if (opts.project) {
      clauses.push("project_path = ?");
      params.push(opts.project);
    }
    if (opts.assistant) {
      clauses.push("assistant = ?");
      params.push(opts.assistant);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as RawSession[];
    return rows.map((r) => this.deserializeSession(r));
  }

  /**
   * Bump the last_active heartbeat for a session.
   * Called on every hook invocation that touches the session, and on Stop/idle.
   * @param id - Session ID
   * @param timestamp - Optional explicit timestamp (defaults to Date.now())
   */
  touchSession(id: string, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    this.db
      .prepare("UPDATE sessions SET last_active = ? WHERE id = ?")
      .run(ts, id);
  }

  /**
   * Determine whether a session is currently alive based on its last_active heartbeat.
   *
   * A session is alive when:
   * 1. end_time IS NULL (session not explicitly ended), AND
   * 2. last_active is within the liveness window (falls back to start_time when last_active IS NULL
   *    for pre-V11 rows — null start_time treated as infinitely stale).
   *
   * isSessionAlive is the SOLE liveness authority for the stop-guard decision.
   * cleanupStaleSessions (start_time-based) is a separate cleanup path and is
   * not consulted here — intentionally avoids a dual-source-of-truth.
   *
   * @param id - Session ID
   * @param withinMs - Liveness window in ms (defaults to SESSION_LIVENESS_WINDOW_MS = 45 min)
   */
  isSessionAlive(
    id: string,
    withinMs: number = SESSION_LIVENESS_WINDOW_MS,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT end_time, last_active, start_time FROM sessions WHERE id = ?",
      )
      .get(id) as {
      end_time: number | null;
      last_active: number | null;
      start_time: number;
    } | null;

    if (!row) return false;
    if (row.end_time !== null) return false; // explicitly ended

    const cutoff = Date.now() - withinMs;
    // Prefer last_active; fall back to start_time for pre-V11 rows
    const heartbeat = row.last_active ?? row.start_time;
    return heartbeat >= cutoff;
  }

  /**
   * Stamp a session as the owner of a spec row (only when spec has no owner yet).
   * Uses a conditional UPDATE so it never overwrites an existing owner.
   * This is idempotent — calling multiple times with the same session ID is safe.
   */
  stampPlanOwner(specId: string, sessionId: string): void {
    this.db
      .prepare(
        "UPDATE specs SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = '')",
      )
      .run(sessionId, specId);
  }

  cleanupStaleSessions(
    thresholdMs: number = STALE_SESSION_THRESHOLD_MS,
  ): number {
    const cutoff = Date.now() - thresholdMs;
    return this.db
      .prepare(
        "UPDATE sessions SET end_time = ? WHERE end_time IS NULL AND start_time < ?",
      )
      .run(Date.now(), cutoff).changes;
  }

  // ─── Notifications ────────────────────────────────────────────────────

  insertNotification(notif: {
    type: NotificationType;
    title: string;
    message?: string | null;
    source?: string | null;
    specId?: string | null;
    sessionId?: string | null;
  }): Notification {
    const result = this.db
      .prepare(
        `INSERT INTO notifications (type, title, message, source, spec_id, session_id, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        notif.type,
        notif.title,
        notif.message ?? null,
        notif.source ?? null,
        notif.specId ?? null,
        notif.sessionId ?? null,
        Date.now(),
      );
    return this.getNotification(Number(result.lastInsertRowid))!;
  }

  private getNotification(id: number): Notification | null {
    const row = this.db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(id) as RawNotification | null;
    return row ? this.deserializeNotification(row) : null;
  }

  getNotifications(
    opts: {
      unread?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Notification[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.unread === true) {
      clauses.push("read = 0");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as RawNotification[];
    return rows.map((r) => this.deserializeNotification(r));
  }

  markNotificationRead(id: number): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
  }

  markAllNotificationsRead(): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  }

  getUnreadNotificationCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
      .get() as { count: number };
    return row.count;
  }

  deleteOldNotifications(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const { count } = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM notifications WHERE created_at < ?",
      )
      .get(cutoff) as { count: number };
    if (count > 0) {
      this.db
        .prepare("DELETE FROM notifications WHERE created_at < ?")
        .run(cutoff);
    }
    return count;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private deserializeNotification(row: RawNotification): Notification {
    return {
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      message: row.message,
      source: row.source,
      specId: row.spec_id,
      sessionId: row.session_id,
      read: row.read === 1,
      createdAt: row.created_at,
    };
  }

  private deserializeSession(row: RawSession): Session {
    return {
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      projectPath: row.project_path,
      assistant: row.assistant as Session["assistant"],
      observationCount: row.observation_count,
      summary: row.summary,
      transcriptPath: row.transcript_path,
      lastActive: row.last_active ?? null,
    };
  }
}
