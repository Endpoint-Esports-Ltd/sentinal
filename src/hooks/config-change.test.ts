/**
 * Config Change Hook Tests
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterAll,
  spyOn,
} from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeTmpDir } from "../test-helpers.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

// Spy on the sidecar client's static connect (restorable — mock.module on
// this module leaks across test files and breaks client.test.ts)
const mockAddObservation = mock((_obs: unknown) => Promise.resolve());
const mockInsertNotification = mock((_notif: unknown) => Promise.resolve());
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () =>
    ({
      addObservation: mockAddObservation,
      insertNotification: mockInsertNotification,
    }) as unknown as SidecarClient,
);

afterAll(() => {
  mockConnect.mockRestore();
});

const { processConfigChange } = await import("./config-change.js");

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/test/project",
    permission_mode: "default",
    hook_event_name: "ConfigChange",
    source: "project_settings",
    ...overrides,
  };
}

describe("processConfigChange", () => {
  beforeEach(() => {
    mockAddObservation.mockClear();
    mockInsertNotification.mockClear();
    mockConnect.mockClear();
  });

  it("should save a memory observation for a .sentinal/rules/*.md file change", async () => {
    const input = makeInput({
      file_path: "/test/project/.sentinal/rules/standards-typescript.md",
    });
    await processConfigChange(input);
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    const obs = mockAddObservation.mock.calls[0][0] as {
      type: string;
      title: string;
    };
    expect(obs.type).toBe("discovery");
    expect(obs.title).toContain("standards-typescript.md");
  });

  it("should save a memory observation for a CLAUDE.md file change", async () => {
    const input = makeInput({ file_path: "/test/project/CLAUDE.md" });
    await processConfigChange(input);
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
  });

  it("should be a no-op for unrelated file changes (e.g. non-md in rules/)", async () => {
    const input = makeInput({
      file_path: "/test/project/.sentinal/rules/config.json",
    });
    await processConfigChange(input);
    expect(mockAddObservation).not.toHaveBeenCalled();
    expect(mockInsertNotification).not.toHaveBeenCalled();
  });

  it("should be a no-op when file_path is undefined", async () => {
    const input = makeInput({});
    await processConfigChange(input);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("should warn via notification when disableAllHooks is detected in settings.json", async () => {
    const tmpDir = makeTmpDir();
    try {
      const settingsPath = join(tmpDir, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({ disableAllHooks: true }, null, 2),
      );
      const input = makeInput({ file_path: settingsPath });
      await processConfigChange(input);
      expect(mockInsertNotification).toHaveBeenCalledTimes(1);
      const notif = mockInsertNotification.mock.calls[0][0] as {
        type: string;
        title: string;
      };
      expect(notif.type).toBe("warning");
      expect(notif.title).toContain("disabled");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── D5: project scoping ──────────────────────────────────────────────────

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  it("scopes a project-file warning to the project IDENTITY, from a linked worktree", async () => {
    const root = realpathSync(makeTmpDir());
    const main = join(root, "main");
    const wt = join(root, "wt");
    try {
      mkdirSync(main);
      git(main, "init", "-q");
      git(
        main,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      git(main, "worktree", "add", "-q", wt);
      mkdirSync(join(wt, ".claude"));
      const settingsPath = join(wt, ".claude", "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true }));

      await processConfigChange(
        makeInput({ cwd: wt, file_path: settingsPath }),
      );

      expect(mockInsertNotification).toHaveBeenCalledTimes(1);
      const notif = mockInsertNotification.mock.calls[0]![0] as {
        projectPath?: string;
        source?: string;
      };
      // The storage key is the MAIN checkout, not the worktree.
      expect(notif.projectPath).toBe(main);
      expect(notif.source).toBe("config-change");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("leaves a warning about a file OUTSIDE the workspace global (no projectPath)", async () => {
    const project = realpathSync(makeTmpDir());
    const userHome = realpathSync(makeTmpDir());
    try {
      git(project, "init", "-q");
      const settingsPath = join(userHome, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true }));

      await processConfigChange(
        makeInput({ cwd: project, file_path: settingsPath }),
      );

      expect(mockInsertNotification).toHaveBeenCalledTimes(1);
      const notif = mockInsertNotification.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect("projectPath" in notif).toBe(false);
      expect(notif.source).toBe("config-change");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 15_000);
});
