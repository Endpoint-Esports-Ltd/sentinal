/**
 * FileChanged Hook Tests
 *
 * Tests the processFileChanged hook which invalidates TDD tracker state
 * when test files are modified externally.
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

// ─── Mock SidecarClient ────────────────────────────────────────────────────────

let clearTddStateCalled = false;
let clearTddStateCalledWith: string | null = null;

const mockClient = {
  clearTddState: mock(async (filePath: string) => {
    clearTddStateCalled = true;
    clearTddStateCalledWith = filePath;
  }),
};

// Spy on the sidecar client's static connect (restorable — mock.module on
// this module leaks across test files and breaks client.test.ts)
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () => mockClient as unknown as SidecarClient,
);

afterAll(() => {
  mockConnect.mockRestore();
});

// Import AFTER mocking
const { processFileChanged } = await import("./file-changed.js");

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeInput(filePath: string, event = "change"): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.json",
    cwd: "/project",
    permission_mode: "default",
    hook_event_name: "FileChanged",
    file_path: filePath,
    event,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("processFileChanged", () => {
  beforeEach(() => {
    clearTddStateCalled = false;
    clearTddStateCalledWith = null;
    mockClient.clearTddState.mockClear();
  });

  it("should clear TDD state when a .test.ts file changes", async () => {
    const input = makeInput("src/hooks/file-checker.test.ts", "change");
    await expect(processFileChanged(input)).resolves.toBeUndefined();
    expect(clearTddStateCalled).toBe(true);
    expect(clearTddStateCalledWith).toBe("src/hooks/file-checker.test.ts");
  });

  it("should clear TDD state when a .spec.ts file changes", async () => {
    const input = makeInput("src/components/button.spec.ts", "create");
    await expect(processFileChanged(input)).resolves.toBeUndefined();
    expect(clearTddStateCalled).toBe(true);
    expect(clearTddStateCalledWith).toBe("src/components/button.spec.ts");
  });

  it("should be a no-op when a non-test .ts file changes", async () => {
    const input = makeInput("src/hooks/file-changed.ts", "change");
    await expect(processFileChanged(input)).resolves.toBeUndefined();
    expect(clearTddStateCalled).toBe(false);
  });
});
