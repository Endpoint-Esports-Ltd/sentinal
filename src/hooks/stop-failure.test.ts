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
import { resolveProjectIdentity } from "../project/identity.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

// Spy on the sidecar client's static connect (restorable — mock.module on
// this module leaks across test files and breaks client.test.ts)
const mockInsertNotification = mock((_notif: unknown) => Promise.resolve());
const mockAddObservation = mock((_obs: unknown) => Promise.resolve());
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () =>
    ({
      insertNotification: mockInsertNotification,
      addObservation: mockAddObservation,
    }) as unknown as SidecarClient,
);

afterAll(() => {
  mockConnect.mockRestore();
});

// Import after mocking
const { processStopFailure } = await import("./stop-failure.js");

describe("processStopFailure", () => {
  beforeEach(() => {
    mockInsertNotification.mockClear();
    mockAddObservation.mockClear();
    mockConnect.mockClear();
  });

  it("should send a warning notification when error is present", async () => {
    const input: HookInput = {
      session_id: "test-session",
      transcript_path: "/tmp/transcript.json",
      cwd: "/tmp/project",
      permission_mode: "default",
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests",
      last_assistant_message: "I was working on the feature...",
    };

    await processStopFailure(input);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockInsertNotification).toHaveBeenCalledTimes(1);
    expect(mockInsertNotification).toHaveBeenCalledWith({
      type: "warning",
      title: "API Error: rate_limit",
      message: "429 Too Many Requests",
      source: "stop-failure",
      projectPath: resolveProjectIdentity("/tmp/project"),
    });
  });

  it("scopes the warning to the project IDENTITY of cwd, not the raw cwd (D5)", async () => {
    const repo = realpathSync(makeTmpDir());
    try {
      execFileSync("git", ["init", "-q", repo]);
      const sub = join(repo, "packages", "app");
      mkdirSync(sub, { recursive: true });

      await processStopFailure({
        session_id: "test-session",
        transcript_path: "/tmp/transcript.json",
        cwd: sub,
        permission_mode: "default",
        hook_event_name: "StopFailure",
        error: "overloaded",
      });

      const notif = mockInsertNotification.mock.calls[0]![0] as {
        projectPath?: string;
        source?: string;
      };
      expect(notif.projectPath).toBe(repo);
      expect(notif.source).toBe("stop-failure");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it("should degrade gracefully when no error field is present", async () => {
    const input: HookInput = {
      session_id: "test-session",
      transcript_path: "/tmp/transcript.json",
      cwd: "/tmp/project",
      permission_mode: "default",
      hook_event_name: "StopFailure",
    };

    // Should not throw
    await expect(processStopFailure(input)).resolves.toBeUndefined();
    // Still connects and notifies (with "unknown" fallback)
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("should return silently when sidecar is unavailable (null client)", async () => {
    mockConnect.mockReturnValueOnce(Promise.resolve(null));

    const stderrSpy: string[] = [];
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg: string | Uint8Array) => {
      stderrSpy.push(String(msg));
      return true;
    };

    const input: HookInput = {
      session_id: "test-session",
      transcript_path: "/tmp/transcript.json",
      cwd: "/tmp/project",
      permission_mode: "default",
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests",
    };

    try {
      await processStopFailure(input);
    } finally {
      process.stderr.write = originalStderr;
    }

    // Should not call insertNotification when client is null
    expect(mockInsertNotification).not.toHaveBeenCalled();
    // Should have logged to stderr
    expect(stderrSpy.some((msg) => msg.includes("sidecar"))).toBe(true);
  });

  it("should save an error observation when an active spec is IN_PROGRESS", async () => {
    // Create a tmp dir with an IN_PROGRESS plan to simulate active spec
    const tmpDir = makeTmpDir();
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "2026-01-01-test-plan.md"),
      "# Test\nStatus: IN_PROGRESS\nApproved: Yes\nType: Feature\n",
    );

    try {
      const input: HookInput = {
        session_id: "test-session",
        transcript_path: "/tmp/transcript.json",
        cwd: tmpDir,
        permission_mode: "default",
        hook_event_name: "StopFailure",
        error: "rate_limit",
        error_details: "429 Too Many Requests",
        last_assistant_message: "I was working on the task...",
      };

      await processStopFailure(input);

      // Both notification and observation should be called
      expect(mockInsertNotification).toHaveBeenCalledTimes(1);
      expect(mockAddObservation).toHaveBeenCalledTimes(1);
      const obsCall = mockAddObservation.mock.calls[0][0] as {
        type: string;
        title: string;
      };
      expect(obsCall.type).toBe("error");
      expect(obsCall.title).toContain("rate_limit");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
