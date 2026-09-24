/**
 * Session Start Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as notificationsModule from "./session-notifications";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectAssistant,
  processSessionStart,
  processSessionStartNotifications,
  type SessionStartDeps,
} from "./session-start";
import type { HookInput } from "../utils/hook-output";

/**
 * `processSessionStart` IS the production path — the CLI dispatcher
 * (`sentinal hook shared session-start`) delegates to it. Real autostart would
 * spawn the user's dashboard/sidecar, so those are injected.
 */
describe("processSessionStart (dispatcher body)", () => {
  const input: HookInput = {
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/work/project-a",
    permission_mode: "default",
    hook_event_name: "SessionStart",
  };

  function deps(over: Partial<SessionStartDeps> = {}) {
    const emitted: string[] = [];
    const created: unknown[] = [];
    const inserted: unknown[] = [];
    const order: string[] = [];
    const d: SessionStartDeps = {
      version: "9.9.9",
      autoStartSidecar: () => {},
      autoStartDashboard: async () => {},
      connectSidecar: async () => ({
        createSession: async (s) => {
          order.push("session");
          created.push(s);
        },
      }),
      openStore: () =>
        ({
          insertSession: (s: unknown) => {
            order.push("session");
            inserted.push(s);
          },
          close: () => {},
        }) as unknown as MemoryStore,
      notifications: async () => {
        order.push("notifications");
        return "DIGEST";
      },
      emit: (c) => emitted.push(c),
      ...over,
    };
    return { d, emitted, created, inserted, order };
  }

  it("creates the session via the sidecar, then emits the digest once", async () => {
    const { d, emitted, created, inserted, order } = deps();
    await processSessionStart(input, d);
    expect(created).toHaveLength(1);
    expect(inserted).toHaveLength(0);
    expect(emitted).toEqual(["DIGEST"]);
    expect(order).toEqual(["session", "notifications"]);
  });

  it("passes the raw cwd to the notification reader (it resolves identity itself)", async () => {
    let seen = "";
    const { d } = deps({
      notifications: async (cwd) => {
        seen = cwd;
        return null;
      },
    });
    await processSessionStart(input, d);
    expect(seen).toBe("/work/project-a");
  });

  it("falls back to the direct store and STILL emits when the sidecar is unavailable", async () => {
    const { d, emitted, inserted } = deps({ connectSidecar: async () => null });
    await processSessionStart(input, d);
    expect(inserted).toHaveLength(1);
    expect(emitted).toEqual(["DIGEST"]);
  });

  it("falls back when the sidecar throws", async () => {
    const { d, inserted } = deps({
      connectSidecar: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await processSessionStart(input, d);
    expect(inserted).toHaveLength(1);
  });

  it("emits nothing when there are no notifications (output unchanged)", async () => {
    const { d, emitted } = deps({ notifications: async () => null });
    await processSessionStart(input, d);
    expect(emitted).toEqual([]);
  });

  it("never throws when everything fails", async () => {
    const { d, emitted } = deps({
      connectSidecar: async () => null,
      openStore: () => {
        throw new Error("db locked");
      },
      notifications: async () => {
        throw new Error("boom");
      },
    });
    await processSessionStart(input, d);
    expect(emitted).toEqual([]);
  });
});
import { MemoryStore } from "../memory/store";
import { resolveProjectIdentity } from "../project/identity";
import { SKEW_NOTIFICATION_SOURCE } from "../sidecar/retire-notify";

describe("processSessionStartNotifications", () => {
  let root: string;
  let dbPath: string;
  let projectA: string;
  let projectB: string;
  let idA: string;
  let idB: string;

  function gitInit(dir: string): void {
    mkdirSync(dir, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", dir]);
  }

  function withStore<T>(fn: (s: MemoryStore) => T): T {
    const s = new MemoryStore(dbPath);
    try {
      return fn(s);
    } finally {
      s.close();
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentinal-ss-notif-"));
    dbPath = join(root, "memory.db");
    projectA = join(root, "a");
    projectB = join(root, "b");
    gitInit(projectA);
    gitInit(projectB);
    mkdirSync(join(projectA, "sub"), { recursive: true });
    idA = resolveProjectIdentity(projectA);
    idB = resolveProjectIdentity(projectB);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null (output unchanged) when there are no notifications", async () => {
    expect(
      await processSessionStartNotifications(projectA, { dbPath }),
    ).toBeNull();
  });

  it("uses the ONE shared candidate query, so it cannot drift from the sidecar route the OpenCode plugin reads", async () => {
    const spy = spyOn(notificationsModule, "listSessionNotificationCandidates");
    try {
      await processSessionStartNotifications(projectA, { dbPath });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe(idA);
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces this project's unread notifications, keyed by canonical identity", async () => {
    withStore((s) =>
      s.insertNotification({
        type: "warning",
        title: "Build broke",
        message: "tsc failed",
        projectPath: idA,
      }),
    );
    // Started from a SUBDIRECTORY — the raw cwd is not the storage key.
    const out = await processSessionStartNotifications(join(projectA, "sub"), {
      dbPath,
    });
    expect(out).toContain("Build broke");
    expect(out).toContain("tsc failed");
  });

  it("surfaces the global skew notification but not unrelated NULL-project history", async () => {
    withStore((s) => {
      s.insertNotification({
        type: "warning",
        title: "Sentinal sidecar outdated (v1 → v2)",
        source: SKEW_NOTIFICATION_SOURCE,
      });
      s.insertNotification({
        type: "info",
        title: "Session ended",
        source: "session-end",
      });
    });
    const out = await processSessionStartNotifications(projectA, { dbPath });
    expect(out).toContain("Sentinal sidecar outdated");
    expect(out).not.toContain("Session ended");
    // The historical row was not acted on.
    withStore((s) => {
      const legacy = s
        .getNotifications()
        .find((n) => n.title === "Session ended")!;
      expect(legacy.read).toBe(false);
    });
  });

  it("neither shows nor marks read project B's notifications from project A", async () => {
    withStore((s) =>
      s.insertNotification({ type: "info", title: "B only", projectPath: idB }),
    );
    const out = await processSessionStartNotifications(projectA, { dbPath });
    expect(out).toBeNull();
    withStore((s) => {
      expect(s.getNotifications({ projectPath: idB })[0]!.read).toBe(false);
    });
  });

  it("decrements the global unread count by exactly the surfaced ids", async () => {
    withStore((s) => {
      s.insertNotification({ type: "info", title: "A1", projectPath: idA });
      s.insertNotification({ type: "info", title: "B1", projectPath: idB });
      s.insertNotification({ type: "info", title: "Legacy" });
    });
    await processSessionStartNotifications(projectA, { dbPath });
    withStore((s) => expect(s.getUnreadNotificationCount()).toBe(2));
  });

  it("does not repeat surfaced notifications on the next session", async () => {
    withStore((s) => {
      s.insertNotification({ type: "info", title: "Once", projectPath: idA });
      s.insertNotification({
        type: "warning",
        title: "Skew once",
        source: SKEW_NOTIFICATION_SOURCE,
      });
    });
    const first = await processSessionStartNotifications(projectA, { dbPath });
    expect(first).toContain("Once");
    expect(first).toContain("Skew once");
    expect(
      await processSessionStartNotifications(projectA, { dbPath }),
    ).toBeNull();
  });

  it("never throws and returns null when the store cannot be opened", async () => {
    const bad = join(root, "no-such-dir", "deeper", "memory.db");
    expect(
      await processSessionStartNotifications(projectA, { dbPath: bad }),
    ).toBeNull();
  });
});

describe("detectAssistant", () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  it("should return 'claude-code' when CLAUDE_PLUGIN_ROOT is set", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/some/path";
    expect(detectAssistant()).toBe("claude-code");
  });

  it("should return 'opencode' when CLAUDE_PLUGIN_ROOT is not set", () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    expect(detectAssistant()).toBe("opencode");
  });

  it("should return 'claude-code' even for empty string value", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "";
    // Empty string is falsy in JS, so this should return opencode
    expect(detectAssistant()).toBe("opencode");
  });
});

describe("session-start integration", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("should insert a session record with correct fields", () => {
    const sessionId = `test-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: "/tmp/transcript.jsonl",
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
    expect(session!.projectPath).toBe("/test/project");
    expect(session!.assistant).toBe("claude-code");
    expect(session!.transcriptPath).toBe("/tmp/transcript.jsonl");
    expect(session!.endTime).toBeNull();
    expect(session!.summary).toBeNull();
  });

  it("should handle opencode assistant type", () => {
    const sessionId = `test-oc-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "opencode",
      summary: null,
      transcriptPath: null,
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.assistant).toBe("opencode");
    expect(session!.transcriptPath).toBeNull();
  });

  it("should handle null transcript path", () => {
    const sessionId = `test-null-${Date.now()}`;

    store.insertSession({
      id: sessionId,
      startTime: Date.now(),
      endTime: null,
      projectPath: "/test/project",
      assistant: "claude-code",
      summary: null,
      transcriptPath: null,
    });

    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.transcriptPath).toBeNull();
  });
});
