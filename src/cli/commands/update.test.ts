import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import {
  getAssetName,
  checkForUpdateWithStore,
  reinstallPlugins,
  runPostUpdateReinstall,
} from "./update.js";
import * as uninstallModule from "./uninstall.js";
import * as installModule from "./install.js";
import { MemoryStore } from "../../memory/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("reinstallPlugins", () => {
  afterEach(() => {
    mock.restore();
  });

  test("should skip reinstall when no installations detected", async () => {
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: false,
      opencode: false,
    });

    // Should not throw and should not call any install/uninstall functions
    await reinstallPlugins();
    // If we got here without error, the skip path worked
  });

  test("should call uninstall and install for OpenCode when detected", async () => {
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: false,
      opencode: true,
    });

    let uninstallCalled = false;
    let installCalled = false;
    let uninstallOpts: unknown = null;

    spyOn(uninstallModule, "uninstallOpenCode").mockImplementation(
      async (opts) => {
        uninstallCalled = true;
        uninstallOpts = opts;
      },
    );
    spyOn(installModule, "installOpenCode").mockImplementation(async () => {
      installCalled = true;
    });

    await reinstallPlugins();

    expect(uninstallCalled).toBe(true);
    expect(installCalled).toBe(true);
    // Should pass preserveBinary: true
    expect(uninstallOpts).toEqual({ preserveBinary: true });
  });

  test("should call uninstall and install for Claude Code when detected", async () => {
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: true,
      opencode: false,
    });

    let uninstallCalled = false;
    let installCalled = false;

    spyOn(uninstallModule, "uninstallClaudeCode").mockImplementation(
      async () => {
        uninstallCalled = true;
      },
    );
    spyOn(installModule, "installClaudeCode").mockImplementation(async () => {
      installCalled = true;
    });

    await reinstallPlugins();

    expect(uninstallCalled).toBe(true);
    expect(installCalled).toBe(true);
  });

  test("should handle uninstall failure gracefully", async () => {
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: true,
      opencode: false,
    });

    spyOn(uninstallModule, "uninstallClaudeCode").mockImplementation(
      async () => {
        throw new Error("Claude CLI not found");
      },
    );

    // Should not throw — failure is non-fatal
    await reinstallPlugins();
  });

  test("should reinstall both when both detected", async () => {
    spyOn(uninstallModule, "detectInstalledTargets").mockReturnValue({
      claude: true,
      opencode: true,
    });

    const calls: string[] = [];

    spyOn(uninstallModule, "uninstallClaudeCode").mockImplementation(
      async () => {
        calls.push("uninstall-claude");
      },
    );
    spyOn(installModule, "installClaudeCode").mockImplementation(async () => {
      calls.push("install-claude");
    });
    spyOn(uninstallModule, "uninstallOpenCode").mockImplementation(async () => {
      calls.push("uninstall-opencode");
    });
    spyOn(installModule, "installOpenCode").mockImplementation(async () => {
      calls.push("install-opencode");
    });

    await reinstallPlugins();

    expect(calls).toEqual([
      "uninstall-claude",
      "install-claude",
      "uninstall-opencode",
      "install-opencode",
    ]);
  });
});

describe("runPostUpdateReinstall", () => {
  let tmpDir: string;
  let fakeBin: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sentinal-update-"));
    fakeBin = join(tmpDir, "sentinal");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  test("should spawn the new binary with 'update --reinstall-plugins' and skip in-process reinstall", async () => {
    const spawnedWith: string[][] = [];
    let detectCalled = false;
    spyOn(uninstallModule, "detectInstalledTargets").mockImplementation(() => {
      detectCalled = true;
      return { claude: false, opencode: false };
    });

    await runPostUpdateReinstall({
      binPath: fakeBin,
      spawner: (cmd: string[]) => {
        spawnedWith.push(cmd);
        return 0;
      },
    });

    expect(spawnedWith).toEqual([[fakeBin, "update", "--reinstall-plugins"]]);
    // In-process reinstall must NOT run when the subprocess succeeded —
    // it would use the OLD process's stale embedded assets.
    expect(detectCalled).toBe(false);
  });

  test("should fall back to in-process reinstall when the spawner throws", async () => {
    let detectCalled = false;
    spyOn(uninstallModule, "detectInstalledTargets").mockImplementation(() => {
      detectCalled = true;
      return { claude: false, opencode: false };
    });

    await runPostUpdateReinstall({
      binPath: fakeBin,
      spawner: () => {
        throw new Error("spawn EACCES");
      },
    });

    expect(detectCalled).toBe(true);
  });

  test("should fall back to in-process reinstall when the subprocess exits non-zero", async () => {
    let detectCalled = false;
    spyOn(uninstallModule, "detectInstalledTargets").mockImplementation(() => {
      detectCalled = true;
      return { claude: false, opencode: false };
    });

    await runPostUpdateReinstall({
      binPath: fakeBin,
      spawner: () => 1,
    });

    expect(detectCalled).toBe(true);
  });

  test("should fall back to in-process reinstall when the binary does not exist", async () => {
    const spawnedWith: string[][] = [];
    let detectCalled = false;
    spyOn(uninstallModule, "detectInstalledTargets").mockImplementation(() => {
      detectCalled = true;
      return { claude: false, opencode: false };
    });

    await runPostUpdateReinstall({
      binPath: join(tmpDir, "missing-binary"),
      spawner: (cmd: string[]) => {
        spawnedWith.push(cmd);
        return 0;
      },
    });

    expect(spawnedWith).toEqual([]);
    expect(detectCalled).toBe(true);
  });
});
