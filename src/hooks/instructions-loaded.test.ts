/**
 * Instructions Loaded Hook Tests
 *
 * Tests that the hook correctly filters by load_reason:
 * - "session_start" → capture observation (addObservation called)
 * - "path_glob_match" → capture observation (addObservation called)
 * - "compact" (and others) → skip (no-op, addObservation NOT called)
 *
 * And that it deduplicates (H9): a repeat load of the same instructions
 * file in the same project TOUCHES the existing observation (content-only
 * updateObservation, which refreshes timestamp/staleness in the store)
 * instead of inserting a duplicate row.
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
const mockAddObservation = mock((_obs: unknown) =>
  Promise.resolve({ id: 1 } as { id: number }),
);
const mockMemorySearch = mock((_opts: unknown) =>
  Promise.resolve([] as unknown[]),
);
const mockMemoryGet = mock((_ids: unknown) => Promise.resolve([] as unknown[]));
const mockUpdateObservation = mock((_patch: unknown) =>
  Promise.resolve({} as unknown),
);
const mockConnect = spyOn(SidecarClient, "connect").mockImplementation(
  async () =>
    ({
      addObservation: mockAddObservation,
      memorySearch: mockMemorySearch,
      updateObservation: mockUpdateObservation,
    }) as unknown as SidecarClient,
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

/**
 * Wire the fake client to behave like a real store: memorySearch returns
 * whatever addObservation previously stored (title/type/timestamp/id).
 */
function useStatefulStore(): { stored: Array<Record<string, unknown>> } {
  const stored: Array<Record<string, unknown>> = [];
  mockAddObservation.mockImplementation(async (obs: unknown) => {
    const o = obs as { title: string; type: string; projectPath: string };
    const id = stored.length + 1;
    stored.push({
      id,
      title: o.title,
      type: o.type,
      projectPath: o.projectPath,
      timestamp: Date.now(),
    });
    return { id };
  });
  mockMemorySearch.mockImplementation(async () => [...stored]);
  mockMemoryGet.mockImplementation(async (ids: unknown) =>
    stored.filter((r) => (ids as number[]).includes(r.id as number)),
  );
  return { stored };
}

describe("processInstructionsLoaded", () => {
  beforeEach(() => {
    mockAddObservation.mockClear();
    mockMemorySearch.mockClear();
    mockUpdateObservation.mockClear();
    mockConnect.mockClear();
    // Defaults: empty store, inserts succeed
    mockAddObservation.mockImplementation(async () => ({ id: 1 }));
    mockMemorySearch.mockImplementation(async () => []);
    mockUpdateObservation.mockImplementation(async () => ({}));
    mockMemoryGet.mockImplementation(async () => []);
    mockConnect.mockImplementation(
      async () =>
        ({
          addObservation: mockAddObservation,
          memorySearch: mockMemorySearch,
          updateObservation: mockUpdateObservation,
          memoryGet: mockMemoryGet,
        }) as unknown as SidecarClient,
    );
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
    expect(mockMemorySearch).not.toHaveBeenCalled();
  });

  it("should capture observation when load_reason is path_glob_match", async () => {
    const input = makeInput({ load_reason: "path_glob_match" });
    await processInstructionsLoaded(input);
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
  });

  // ─── H9 deduplication ─────────────────────────────────────────────────────

  it("should touch (not re-insert) when the same file+project was already recorded", async () => {
    useStatefulStore();

    await processInstructionsLoaded(makeInput());
    await processInstructionsLoaded(makeInput());

    // One insert + one touch — NOT two inserts
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    expect(mockUpdateObservation).toHaveBeenCalledTimes(1);
    const patch = mockUpdateObservation.mock.calls[0][0] as {
      id: number;
      title?: string;
      type?: string;
    };
    expect(patch.id).toBe(1);
    // Touch must not change type/title identity
    expect(patch.type ?? "discovery").toBe("discovery");
  });

  it("should scope the dedup search to the project and discovery type", async () => {
    useStatefulStore();
    await processInstructionsLoaded(makeInput());
    expect(mockMemorySearch).toHaveBeenCalledTimes(1);
    const opts = mockMemorySearch.mock.calls[0][0] as {
      query: string;
      project?: string;
      type?: string;
    };
    expect(opts.query).toBe("Instructions loaded: CLAUDE.md");
    expect(opts.project).toBe("/test/project");
    expect(opts.type).toBe("discovery");
  });

  it("should require EXACT title equality — ranked near-matches do not dedup", async () => {
    mockMemorySearch.mockImplementation(async () => [
      {
        id: 7,
        title: "Instructions loaded: AGENTS.md",
        type: "discovery",
        timestamp: Date.now(),
      },
    ]);
    await processInstructionsLoaded(makeInput());
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    expect(mockUpdateObservation).not.toHaveBeenCalled();
  });

  it("should insert separately for different files", async () => {
    useStatefulStore();

    await processInstructionsLoaded(
      makeInput({ file_path: "/test/project/CLAUDE.md" }),
    );
    await processInstructionsLoaded(
      makeInput({ file_path: "/test/project/AGENTS.md" }),
    );

    expect(mockAddObservation).toHaveBeenCalledTimes(2);
    expect(mockUpdateObservation).not.toHaveBeenCalled();
  });

  it("should fall through to insert when the dedup search throws (availability beats dedup)", async () => {
    mockMemorySearch.mockImplementation(async () => {
      throw new Error("search backend down");
    });
    await processInstructionsLoaded(makeInput());
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    expect(mockUpdateObservation).not.toHaveBeenCalled();
  });

  it("should stay a silent no-op when the sidecar is unavailable", async () => {
    mockConnect.mockImplementation(async () => null);
    await processInstructionsLoaded(makeInput());
    expect(mockAddObservation).not.toHaveBeenCalled();
    expect(mockUpdateObservation).not.toHaveBeenCalled();
  });
});

describe("cross-project ownership guard (spec-review should_fix)", () => {
  beforeEach(() => {
    mockAddObservation.mockClear();
    mockMemorySearch.mockClear();
    mockUpdateObservation.mockClear();
    mockMemoryGet.mockClear();
    mockConnect.mockClear();
    mockAddObservation.mockImplementation(async () => ({ id: 1 }));
    mockUpdateObservation.mockImplementation(async () => ({}));
    mockConnect.mockImplementation(
      async () =>
        ({
          addObservation: mockAddObservation,
          memorySearch: mockMemorySearch,
          updateObservation: mockUpdateObservation,
          memoryGet: mockMemoryGet,
        }) as unknown as SidecarClient,
    );
  });

  it("should INSERT, not touch, when the title match belongs to another project", async () => {
    // Simulates a regressed/ranked-cross-project server filter: search returns
    // a row whose title matches exactly but which lives in a DIFFERENT project.
    mockMemorySearch.mockImplementation(async () => [
      {
        id: 42,
        title: "Instructions loaded: CLAUDE.md",
        type: "discovery",
        timestamp: Date.now(),
      },
    ]);
    mockMemoryGet.mockImplementation(async () => [
      {
        id: 42,
        title: "Instructions loaded: CLAUDE.md",
        projectPath: "/OTHER/project",
      },
    ]);
    await processInstructionsLoaded(makeInput({ cwd: "/test/project" }));
    expect(mockUpdateObservation).not.toHaveBeenCalled();
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
  });

  it("should touch when the title match is confirmed to belong to this project", async () => {
    mockMemorySearch.mockImplementation(async () => [
      {
        id: 42,
        title: "Instructions loaded: CLAUDE.md",
        type: "discovery",
        timestamp: Date.now(),
      },
    ]);
    mockMemoryGet.mockImplementation(async () => [
      {
        id: 42,
        title: "Instructions loaded: CLAUDE.md",
        projectPath: "/test/project",
      },
    ]);
    await processInstructionsLoaded(makeInput({ cwd: "/test/project" }));
    expect(mockUpdateObservation).toHaveBeenCalledTimes(1);
    expect(mockAddObservation).not.toHaveBeenCalled();
  });

  it("should fall through to insert when memoryGet fails (availability beats dedup)", async () => {
    mockMemorySearch.mockImplementation(async () => [
      {
        id: 42,
        title: "Instructions loaded: CLAUDE.md",
        type: "discovery",
        timestamp: Date.now(),
      },
    ]);
    mockMemoryGet.mockImplementation(async () => {
      throw new Error("route down");
    });
    await processInstructionsLoaded(makeInput({ cwd: "/test/project" }));
    expect(mockUpdateObservation).not.toHaveBeenCalled();
    expect(mockAddObservation).toHaveBeenCalledTimes(1);
  });
});
