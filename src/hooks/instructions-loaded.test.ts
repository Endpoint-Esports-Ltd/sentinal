/**
 * Instructions Loaded Hook Tests
 *
 * Tests that the hook correctly filters by load_reason:
 * - "session_start" → capture observation (addObservation called)
 * - "path_glob_match" → capture observation (addObservation called)
 * - "compact" (and others) → skip (no-op, addObservation NOT called)
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
const mockAddObservation = mock((_obs: unknown) => Promise.resolve());
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () =>
    ({ addObservation: mockAddObservation }) as unknown as SidecarClient,
);

afterAll(() => {
  mockConnect.mockRestore();
});

const { processInstructionsLoaded } = await import("./instructions-loaded.js");

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/test/project",
    permission_mode: "default",
    hook_event_name: "InstructionsLoaded",
    file_path: "/test/project/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
    ...overrides,
  };
}

describe("processInstructionsLoaded", () => {
  beforeEach(() => {
    mockAddObservation.mockClear();
    mockConnect.mockClear();
  });

  it("should capture observation when load_reason is session_start", async () => {
    const input = makeInput({ load_reason: "session_start" });
    await processInstructionsLoaded(input);
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    const obs = mockAddObservation.mock.calls[0][0] as {
      type: string;
      title: string;
    };
    expect(obs.type).toBe("discovery");
    expect(obs.title).toContain("CLAUDE.md");
  });

  it("should skip (no-op) when load_reason is compact — addObservation NOT called", async () => {
    const input = makeInput({ load_reason: "compact" });
    await processInstructionsLoaded(input);
    expect(mockAddObservation).not.toHaveBeenCalled();
  });

  it("should capture observation when load_reason is path_glob_match", async () => {
    const input = makeInput({ load_reason: "path_glob_match" });
    await processInstructionsLoaded(input);
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
  });
});
