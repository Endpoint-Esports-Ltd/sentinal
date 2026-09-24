import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { makeTmpDir } from "../test-helpers.js";
import * as fileLogModule from "../utils/file-log.js";
import { SIDECAR_LOG_FILE, readLastLines } from "../utils/file-log.js";
import {
  notifySkewOnce,
  skewNotifiedKey,
  SKEW_NOTIFICATION_SOURCE,
  type SkewNotifyContext,
} from "./retire-notify.js";

describe("notifySkewOnce", () => {
  let tmpDir: string;
  let store: MemoryStore;

  const logLines = (): string[] =>
    readLastLines(join(tmpDir, SIDECAR_LOG_FILE), 100);

  beforeEach(() => {
    tmpDir = makeTmpDir("retire-notify");
    store = new MemoryStore(join(tmpDir, "test.db"));
    spyOn(fileLogModule, "getLogDir").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("fires exactly once per installed version across repeated calls", () => {
    const ctx: SkewNotifyContext = { store };
    expect(notifySkewOnce(ctx, "1.0.0", "1.1.0")).toBe(true);
    expect(notifySkewOnce(ctx, "1.0.0", "1.1.0")).toBe(false);
    expect(notifySkewOnce(ctx, "1.0.0", "1.1.0")).toBe(false);

    const notifications = store.getNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.type).toBe("warning");
    expect(notifications[0]!.source).toBe(SKEW_NOTIFICATION_SOURCE);
  });

  it("fires again for a NEW installed version", () => {
    const ctx: SkewNotifyContext = { store };
    expect(notifySkewOnce(ctx, "1.0.0", "1.1.0")).toBe(true);
    expect(notifySkewOnce(ctx, "1.0.0", "1.2.0")).toBe(true);
    expect(notifySkewOnce(ctx, "1.0.0", "1.2.0")).toBe(false);
    expect(store.getNotifications().length).toBe(2);
  });

  it("scopes the settings key by the installed (target) version", () => {
    notifySkewOnce({ store }, "1.0.0", "1.1.0");
    expect(store.getSetting(skewNotifiedKey("1.1.0"))).not.toBeNull();
    expect(store.getSetting(skewNotifiedKey("1.0.0"))).toBeNull();
    // A different running version skewing to the same target is still the
    // same upgrade — do not re-notify.
    expect(notifySkewOnce({ store }, "0.9.0", "1.1.0")).toBe(false);
  });

  it("names both versions and the remedy in notification and log", () => {
    notifySkewOnce({ store }, "1.0.0", "1.1.0");
    const n = store.getNotifications()[0]!;
    const text = `${n.title} ${n.message ?? ""}`;
    expect(text).toContain("v1.0.0");
    expect(text).toContain("v1.1.0");
    expect(n.message).toContain("sentinal sidecar restart");

    const lines = logLines().filter((l) => l.includes("v1.1.0"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("v1.0.0");
    expect(lines[0]).toContain("sentinal sidecar restart");
  });

  it("leaves specId null", () => {
    notifySkewOnce({ store }, "1.0.0", "1.1.0");
    expect(store.getNotifications()[0]!.specId).toBeNull();
  });

  it("does not log again on suppressed calls", () => {
    notifySkewOnce({ store }, "1.0.0", "1.1.0");
    notifySkewOnce({ store }, "1.0.0", "1.1.0");
    expect(logLines().filter((l) => l.includes("v1.1.0")).length).toBe(1);
  });

  it("writes the key at attempt START so a failing insert cannot retry-loop", () => {
    const failing: SkewNotifyContext = {
      store: {
        getSetting: (k: string) => store.getSetting(k),
        setSetting: (k: string, v: string) => store.setSetting(k, v),
        insertNotification: () => {
          throw new Error("disk I/O error");
        },
      },
    };
    expect(() => notifySkewOnce(failing, "1.0.0", "1.1.0")).not.toThrow();
    expect(store.getSetting(skewNotifiedKey("1.1.0"))).not.toBeNull();
    // Second attempt is suppressed by the key written before the crash.
    expect(notifySkewOnce(failing, "1.0.0", "1.1.0")).toBe(false);
  });

  it("swallows a store failure and never throws", () => {
    const broken: SkewNotifyContext = {
      store: {
        getSetting: () => {
          throw new Error("database is locked");
        },
        setSetting: () => {
          throw new Error("database is locked");
        },
        insertNotification: () => {
          throw new Error("database is locked");
        },
      },
    };
    expect(() => notifySkewOnce(broken, "1.0.0", "1.1.0")).not.toThrow();
    expect(notifySkewOnce(broken, "1.0.0", "1.1.0")).toBe(false);
  });

  it("is a no-op when versions match", () => {
    expect(notifySkewOnce({ store }, "1.1.0", "1.1.0")).toBe(false);
    expect(store.getNotifications().length).toBe(0);
  });
});
