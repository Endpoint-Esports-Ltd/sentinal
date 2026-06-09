/**
 * TaskCreated Hook Tests
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
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

// Spy on the sidecar client's static connect (restorable — mock.module on
// this module leaks across test files and breaks client.test.ts)
const mockInsertNotification = mock((_notif: unknown) => Promise.resolve());
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () =>
    ({
      insertNotification: mockInsertNotification,
    }) as unknown as SidecarClient,
);

afterAll(() => {
  mockConnect.mockRestore();
});

const { processTaskCreated } = await import("./task-created.js");

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.json",
    cwd: "/tmp/project",
    permission_mode: "default",
    hook_event_name: "TaskCreated",
    ...overrides,
  };
}

describe("processTaskCreated", () => {
  beforeEach(() => {
    mockInsertNotification.mockClear();
    mockConnect.mockClear();
  });

  it("should send notification with task_subject as title when provided", async () => {
    const input = makeInput({
      task_id: "task-abc123",
      task_subject: "Implement auth module",
      task_description: "Build JWT authentication for the API",
    });
    await processTaskCreated(input);
    expect(mockInsertNotification).toHaveBeenCalledTimes(1);
    const notif = mockInsertNotification.mock.calls[0][0] as {
      type: string;
      title: string;
    };
    expect(notif.type).toBe("info");
    expect(notif.title).toContain("Implement auth module");
  });

  it("should fall back to task_id in title when task_subject is missing", async () => {
    const input = makeInput({
      task_id: "task-xyz789",
      task_description: "Some task without a subject",
    });
    await processTaskCreated(input);
    expect(mockInsertNotification).toHaveBeenCalledTimes(1);
    const notif = mockInsertNotification.mock.calls[0][0] as {
      type: string;
      title: string;
    };
    expect(notif.title).toContain("task-xyz789");
  });

  it("should not throw when sidecar is unavailable", async () => {
    mockConnect.mockReturnValueOnce(Promise.resolve(null));
    const input = makeInput({
      task_id: "task-no-sidecar",
      task_subject: "Test",
    });
    await expect(processTaskCreated(input)).resolves.toBeUndefined();
    expect(mockInsertNotification).not.toHaveBeenCalled();
  });
});
