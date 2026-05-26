/**
 * Config Change Hook Tests
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import type { HookInput } from "../utils/hook-output.js";

// Mock the sidecar client
const mockAddObservation = mock(() => Promise.resolve());
const mockInsertNotification = mock(() => Promise.resolve());
const mockConnect = mock(() =>
  Promise.resolve({
    addObservation: mockAddObservation,
    insertNotification: mockInsertNotification,
  }),
);

mock.module("../sidecar/client.js", () => ({
  SidecarClient: { connect: mockConnect },
}));

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
    const obs = mockAddObservation.mock.calls[0][0] as { type: string; title: string };
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
      writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true }, null, 2));
      const input = makeInput({ file_path: settingsPath });
      await processConfigChange(input);
      expect(mockInsertNotification).toHaveBeenCalledTimes(1);
      const notif = mockInsertNotification.mock.calls[0][0] as { type: string; title: string };
      expect(notif.type).toBe("warning");
      expect(notif.title).toContain("disabled");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
