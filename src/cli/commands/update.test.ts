import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { getAssetName, checkForUpdateWithStore } from "./update.js";
import { MemoryStore } from "../../memory/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { realpathSync } from "node:fs";

describe("getAssetName", () => {
  test("returns a string for supported platforms", () => {
    const name = getAssetName();
    // We're running tests on a real machine, so it should match
    if (
      (platform() === "linux" || platform() === "darwin") &&
      (arch() === "x64" || arch() === "arm64")
    ) {
      expect(name).toBeString();
      expect(name).toStartWith("sentinal-");
    }
  });

  test("asset name follows expected format", () => {
    const name = getAssetName();
    if (name) {
      expect(name).toMatch(/^sentinal-(linux|darwin)-(x64|arm64)$/);
    }
  });
});

describe("checkForUpdateWithStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-update-test-")));
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns cached result when check is recent", async () => {
    // Pre-populate cache
    store.setSetting("update_last_check", String(Date.now()));
    store.setSetting("update_latest_version", "2.0.0");

    const result = await checkForUpdateWithStore(store, "1.0.9");

    expect(result.fromCache).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("2.0.0");
    expect(result.currentVersion).toBe("1.0.9");
  });

  test("cached result shows no update when versions match", async () => {
    store.setSetting("update_last_check", String(Date.now()));
    store.setSetting("update_latest_version", "1.0.9");

    const result = await checkForUpdateWithStore(store, "1.0.9");

    expect(result.fromCache).toBe(true);
    expect(result.updateAvailable).toBe(false);
  });

  test("cached result shows no update when current is newer", async () => {
    store.setSetting("update_last_check", String(Date.now()));
    store.setSetting("update_latest_version", "1.0.0");

    const result = await checkForUpdateWithStore(store, "1.0.9");

    expect(result.fromCache).toBe(true);
    expect(result.updateAvailable).toBe(false);
  });

  test("stale cache triggers fresh check", async () => {
    // Cache is 25 hours old
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    store.setSetting("update_last_check", String(staleTime));
    store.setSetting("update_latest_version", "1.0.0");

    // This will try to hit GitHub API (which may fail in CI)
    const result = await checkForUpdateWithStore(store, "1.0.9");

    // Either got a fresh result or failed gracefully
    expect(result.fromCache).toBe(false);
    expect(result.currentVersion).toBe("1.0.9");
  });

  test("no cache triggers fresh check", async () => {
    const result = await checkForUpdateWithStore(store, "1.0.9");

    expect(result.fromCache).toBe(false);
    expect(result.currentVersion).toBe("1.0.9");
  });
});
