/**
 * Notification CRUD Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";

describe("MemoryStore — Notifications", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("should insert a notification and return it", () => {
    const notif = store.insertNotification({
      type: "info",
      title: "Session ended",
      message: "Session abc-123 completed",
      source: "session-end",
      sessionId: "abc-123",
    });

    expect(notif.id).toBeGreaterThan(0);
    expect(notif.type).toBe("info");
    expect(notif.title).toBe("Session ended");
    expect(notif.message).toBe("Session abc-123 completed");
    expect(notif.source).toBe("session-end");
    expect(notif.sessionId).toBe("abc-123");
    expect(notif.specId).toBeNull();
    expect(notif.read).toBe(false);
    expect(notif.createdAt).toBeGreaterThan(0);
  });

  it("should list notifications in reverse chronological order", () => {
    store.insertNotification({ type: "info", title: "First" });
    store.insertNotification({ type: "warning", title: "Second" });
    store.insertNotification({ type: "error", title: "Third" });

    const all = store.getNotifications();
    expect(all).toHaveLength(3);
    expect(all[0].title).toBe("Third");
    expect(all[1].title).toBe("Second");
    expect(all[2].title).toBe("First");
  });

  it("should filter unread notifications", () => {
    const n1 = store.insertNotification({ type: "info", title: "Read me" });
    store.insertNotification({ type: "warning", title: "Unread" });

    store.markNotificationRead(n1.id);

    const unread = store.getNotifications({ unread: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe("Unread");
  });

  it("should respect limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      store.insertNotification({ type: "info", title: `Notification ${i}` });
    }

    const page1 = store.getNotifications({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].title).toBe("Notification 9");

    const page2 = store.getNotifications({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].title).toBe("Notification 6");
  });

  it("should mark a single notification as read", () => {
    const n = store.insertNotification({ type: "info", title: "Test" });
    expect(n.read).toBe(false);

    store.markNotificationRead(n.id);

    const all = store.getNotifications();
    expect(all[0].read).toBe(true);
  });

  it("should mark all notifications as read", () => {
    store.insertNotification({ type: "info", title: "A" });
    store.insertNotification({ type: "warning", title: "B" });
    store.insertNotification({ type: "error", title: "C" });

    expect(store.getUnreadNotificationCount()).toBe(3);

    store.markAllNotificationsRead();

    expect(store.getUnreadNotificationCount()).toBe(0);
    const all = store.getNotifications();
    expect(all.every((n) => n.read)).toBe(true);
  });

  it("should return correct unread count", () => {
    expect(store.getUnreadNotificationCount()).toBe(0);

    store.insertNotification({ type: "info", title: "A" });
    store.insertNotification({ type: "info", title: "B" });
    expect(store.getUnreadNotificationCount()).toBe(2);

    const n = store.insertNotification({ type: "info", title: "C" });
    store.markNotificationRead(n.id);
    expect(store.getUnreadNotificationCount()).toBe(2);
  });

  it("should delete old notifications", async () => {
    // Insert notifications — they'll have createdAt = Date.now()
    store.insertNotification({ type: "info", title: "Recent" });
    store.insertNotification({ type: "info", title: "Also recent" });

    // Deleting notifications older than 1 hour should remove none
    const deleted = store.deleteOldNotifications(60 * 60 * 1000);
    expect(deleted).toBe(0);
    expect(store.getNotifications()).toHaveLength(2);
  });

  it("should handle all notification types", () => {
    const types = ["info", "warning", "error", "success"] as const;
    for (const type of types) {
      const n = store.insertNotification({ type, title: `Type: ${type}` });
      expect(n.type).toBe(type);
    }
    expect(store.getNotifications()).toHaveLength(4);
  });

  it("should handle nullable fields", () => {
    const n = store.insertNotification({
      type: "info",
      title: "Minimal",
    });

    expect(n.message).toBeNull();
    expect(n.source).toBeNull();
    expect(n.specId).toBeNull();
    expect(n.sessionId).toBeNull();
  });
});
