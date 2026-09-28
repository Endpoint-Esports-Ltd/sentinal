/**
 * Tests for the once-per-day "old client sent a project-less TDD set" signal
 * (D4 of docs/plans/2026-09-28-deferred-items.md).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import {
  TDD_MISSING_PROJECT_SOURCE,
  TDD_MISSING_PROJECT_SETTING,
  notifyMissingTddProjectOnce,
} from "./tdd-project-notify.js";

const DAY1 = new Date(2026, 8, 28, 9, 0, 0);
const DAY1_LATE = new Date(2026, 8, 28, 23, 59, 0);
const DAY2 = new Date(2026, 8, 29, 0, 1, 0);

describe("notifyMissingTddProjectOnce", () => {
  let store: MemoryStore;
  const rows = () =>
    store
      .getRawDb()
      .prepare(
        "SELECT type, title, message, source, project_path FROM notifications",
      )
      .all() as Array<{
      type: string;
      title: string;
      message: string | null;
      source: string | null;
      project_path: string | null;
    }>;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });
  afterEach(() => store.close());

  it("inserts one global warning naming the fix", () => {
    expect(notifyMissingTddProjectOnce({ store }, DAY1)).toBe(true);
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe("warning");
    expect(all[0]!.source).toBe(TDD_MISSING_PROJECT_SOURCE);
    expect(all[0]!.project_path).toBeNull();
    const text = `${all[0]!.title} ${all[0]!.message}`;
    expect(text).toContain("1.37.1");
    expect(text).toContain("sentinal update");
    expect(text).toContain("sentinal sidecar restart");
  });

  it("fires at most once per calendar day, again the next day", () => {
    expect(notifyMissingTddProjectOnce({ store }, DAY1)).toBe(true);
    expect(notifyMissingTddProjectOnce({ store }, DAY1_LATE)).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(notifyMissingTddProjectOnce({ store }, DAY2)).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  it("stores the day in a settings key", () => {
    notifyMissingTddProjectOnce({ store }, DAY1);
    expect(store.getSetting(TDD_MISSING_PROJECT_SETTING)).toBe("2026-09-28");
  });

  it("never throws when the store is unusable", () => {
    const broken = {
      getSetting: () => {
        throw new Error("closed");
      },
      setSetting: () => {},
      insertNotification: () => {
        throw new Error("closed");
      },
    };
    expect(notifyMissingTddProjectOnce({ store: broken as never }, DAY1)).toBe(
      false,
    );
  });
});
