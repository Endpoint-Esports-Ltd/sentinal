/**
 * Session Notifications — pure selector / formatter / orchestration tests.
 *
 * These are the target-agnostic halves shared by the Claude Code SessionStart
 * hook and (Task 12) the OpenCode plugin's `session.created` handler.
 */

import { describe, it, expect } from "bun:test";
import type { Notification } from "../memory/types.js";
import { SKEW_NOTIFICATION_SOURCE } from "../sidecar/retire-notify.js";
import {
  GLOBAL_NOTIFICATION_SOURCES,
  MAX_SESSION_NOTIFICATIONS,
  MAX_NOTIFICATION_MESSAGE_CHARS,
  selectSessionNotifications,
  formatNotificationDigest,
  surfaceSessionNotifications,
  listSessionNotificationCandidates,
  type SessionNotificationReader,
} from "./session-notifications.js";

const PROJECT = "/work/project-a";
const OTHER = "/work/project-b";

let nextId = 1;
function notif(over: Partial<Notification> = {}): Notification {
  const id = nextId++;
  return {
    id,
    type: "info",
    title: `Title ${id}`,
    message: null,
    source: null,
    specId: null,
    sessionId: null,
    projectPath: PROJECT,
    read: false,
    createdAt: 1_000 + id,
    ...over,
  };
}

describe("GLOBAL_NOTIFICATION_SOURCES", () => {
  it("is a narrow allow-list containing exactly the skew source", () => {
    expect([...GLOBAL_NOTIFICATION_SOURCES]).toEqual([
      SKEW_NOTIFICATION_SOURCE,
    ]);
  });
});

describe("selectSessionNotifications", () => {
  it("keeps unread rows for this project", () => {
    const a = notif();
    expect(selectSessionNotifications([a], PROJECT)).toEqual([a]);
  });

  it("drops rows belonging to another project", () => {
    expect(
      selectSessionNotifications([notif({ projectPath: OTHER })], PROJECT),
    ).toEqual([]);
  });

  it("drops read rows", () => {
    expect(
      selectSessionNotifications([notif({ read: true })], PROJECT),
    ).toEqual([]);
  });

  it("keeps a NULL-project row whose source is on the global allow-list", () => {
    const skew = notif({ projectPath: null, source: SKEW_NOTIFICATION_SOURCE });
    expect(selectSessionNotifications([skew], PROJECT)).toEqual([skew]);
  });

  it("keeps a skew row even when projectPath is absent (pre-V13 wire)", () => {
    const skew = notif({ source: SKEW_NOTIFICATION_SOURCE });
    delete (skew as { projectPath?: string | null }).projectPath;
    expect(selectSessionNotifications([skew], PROJECT)).toEqual([skew]);
  });

  it("drops NULL-project historical rows from any other source", () => {
    const rows = [
      notif({ projectPath: null, source: "session-end" }),
      notif({ projectPath: null, source: null }),
      notif({ projectPath: null, source: "self-heal" }),
    ];
    expect(selectSessionNotifications(rows, PROJECT)).toEqual([]);
  });

  it("does not treat a skew-sourced row of ANOTHER project as global", () => {
    const row = notif({ projectPath: OTHER, source: SKEW_NOTIFICATION_SOURCE });
    expect(selectSessionNotifications([row], PROJECT)).toEqual([]);
  });

  it("orders newest first and caps the count", () => {
    const rows = Array.from({ length: MAX_SESSION_NOTIFICATIONS + 3 }, (_, i) =>
      notif({ createdAt: 10_000 + i }),
    );
    const out = selectSessionNotifications(rows, PROJECT);
    expect(out).toHaveLength(MAX_SESSION_NOTIFICATIONS);
    expect(out[0]!.createdAt).toBe(10_000 + MAX_SESSION_NOTIFICATIONS + 2);
  });
});

describe("formatNotificationDigest", () => {
  it("returns null for no notifications", () => {
    expect(formatNotificationDigest([])).toBeNull();
  });

  it("names type, title and message of each notification", () => {
    const out = formatNotificationDigest([
      notif({ type: "warning", title: "Sidecar outdated", message: "Restart" }),
    ])!;
    expect(out).toContain("Sentinal notifications");
    expect(out).toContain("[warning] Sidecar outdated");
    expect(out).toContain("Restart");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(MAX_NOTIFICATION_MESSAGE_CHARS * 3);
    const out = formatNotificationDigest([notif({ message: long })])!;
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(MAX_NOTIFICATION_MESSAGE_CHARS - 1));
    expect(out).toContain("…");
  });
});

function fakeReader(rows: Notification[], failMark: Set<number> = new Set()) {
  const marked: number[] = [];
  const calls: Array<{ projectPath: string; limit: number }> = [];
  const reader: SessionNotificationReader = {
    listCandidates: async (projectPath, limit) => {
      calls.push({ projectPath, limit });
      return rows;
    },
    markRead: async (id) => {
      if (failMark.has(id)) throw new Error("SQLITE_BUSY");
      marked.push(id);
    },
  };
  return { reader, marked, calls };
}

describe("surfaceSessionNotifications", () => {
  it("returns null and marks nothing when there is nothing to surface", async () => {
    const { reader, marked } = fakeReader([notif({ projectPath: OTHER })]);
    expect(await surfaceSessionNotifications(reader, PROJECT)).toBeNull();
    expect(marked).toEqual([]);
  });

  it("marks exactly the surfaced ids — never another project's", async () => {
    const mine = notif({ title: "Mine" });
    const theirs = notif({ projectPath: OTHER, title: "Theirs" });
    const skew = notif({ projectPath: null, source: SKEW_NOTIFICATION_SOURCE });
    const { reader, marked, calls } = fakeReader([mine, theirs, skew]);

    const out = await surfaceSessionNotifications(reader, PROJECT);

    expect(out).toContain("Mine");
    expect(out).not.toContain("Theirs");
    expect(marked.sort()).toEqual([mine.id, skew.id].sort());
    expect(calls[0]!.projectPath).toBe(PROJECT);
  });

  it("omits a notification whose mark-read failed, so it is not lost", async () => {
    const ok = notif({ title: "Marked" });
    const busy = notif({ title: "Busy" });
    const { reader } = fakeReader([ok, busy], new Set([busy.id]));
    const out = await surfaceSessionNotifications(reader, PROJECT);
    expect(out).toContain("Marked");
    expect(out).not.toContain("Busy");
  });

  it("never throws when the reader throws", async () => {
    const reader: SessionNotificationReader = {
      listCandidates: async () => {
        throw new Error("db gone");
      },
      markRead: async () => {},
    };
    expect(await surfaceSessionNotifications(reader, PROJECT)).toBeNull();
  });
});

describe("listSessionNotificationCandidates", () => {
  it("queries this project's unread rows AND the global allow-list, one call each", () => {
    const calls: unknown[] = [];
    const mine = notif({ projectPath: PROJECT });
    const skew = notif({ projectPath: null, source: SKEW_NOTIFICATION_SOURCE });
    const store = {
      getNotifications: (opts: unknown) => {
        calls.push(["getNotifications", opts]);
        return [mine];
      },
      getUnreadGlobalNotifications: (
        sources: readonly string[],
        limit: number,
      ) => {
        calls.push(["getUnreadGlobalNotifications", sources, limit]);
        return [skew];
      },
    };
    const got = listSessionNotificationCandidates(store, PROJECT, 3);
    expect(got).toEqual([mine, skew]);
    expect(calls).toEqual([
      ["getNotifications", { unread: true, projectPath: PROJECT, limit: 3 }],
      ["getUnreadGlobalNotifications", GLOBAL_NOTIFICATION_SOURCES, 3],
    ]);
  });
});
