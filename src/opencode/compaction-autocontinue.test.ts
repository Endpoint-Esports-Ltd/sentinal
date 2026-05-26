import { describe, it, expect } from "bun:test";
import type { SidecarClient } from "../sidecar/client.js";
import type { TddCycle } from "../memory/types.js";
import type { Spec } from "../spec/types.js";
import { handleCompactionAutocontinue } from "./compaction-autocontinue.js";

// Minimal mock shape — only the methods we need
function makeMockSidecar(opts: {
  tddStates?: TddCycle[];
  currentSpec?: Spec | null;
}): SidecarClient {
  return {
    listActiveTddStates: async () => opts.tddStates ?? [],
    getCurrentSpec: async (_projectPath: string) => opts.currentSpec ?? null,
  } as unknown as SidecarClient;
}

describe("handleCompactionAutocontinue", () => {
  it("returns shouldContinue:true with empty context when sidecar is null", async () => {
    const result = await handleCompactionAutocontinue(null, "/project");
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("returns shouldContinue:false when TDD is in RED_CONFIRMED state", async () => {
    const tddStates: TddCycle[] = [
      {
        id: 1,
        filePath: "/project/src/foo.ts", // matches projectPath "/project"
        specId: null,
        taskPosition: null,
        state: "RED_CONFIRMED",
        testFilePath: null,
        lastFailOutput: null,
        updatedAt: Date.now(),
      },
    ];
    const sidecar = makeMockSidecar({ tddStates });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    expect(result.shouldContinue).toBe(false);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toContain("RED");
  });

  it("returns shouldContinue:true with spec resume directive when spec is IN_PROGRESS", async () => {
    const spec: Spec = {
      id: "spec-1",
      title: "My Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-01-01-my-feature.md",
      tasks: [
        {
          position: 1,
          title: "Setup types",
          status: "complete",
        },
        {
          position: 2,
          title: "Implement handler",
          status: "in-progress",
        },
        {
          position: 3,
          title: "Write tests",
          status: "pending",
        },
      ],
      metadata: {},
    };
    const sidecar = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    expect(result.shouldContinue).toBe(true);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toContain("docs/plans/2026-01-01-my-feature.md");
    expect(result.context[0]).toContain("Task 2");
    expect(result.context[0]).toContain("Implement handler");
  });

  it("falls back to first pending task when no in-progress task exists", async () => {
    const spec: Spec = {
      id: "spec-2",
      title: "Another Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-02-01-another.md",
      tasks: [
        {
          position: 1,
          title: "First task",
          status: "complete",
        },
        {
          position: 2,
          title: "Second task",
          status: "pending",
        },
      ],
      metadata: {},
    };
    const sidecar = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    expect(result.shouldContinue).toBe(true);
    expect(result.context[0]).toContain("Task 2");
    expect(result.context[0]).toContain("Second task");
  });

  it("returns shouldContinue:true with empty context when idle (no TDD red, no active spec)", async () => {
    const sidecar = makeMockSidecar({ tddStates: [], currentSpec: null });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("filters TDD states by projectPath — ignores RED_CONFIRMED from other projects", async () => {
    const tddStates: TddCycle[] = [
      {
        id: 1,
        filePath: "/other-project/src/foo.ts", // different project
        specId: null,
        taskPosition: null,
        state: "RED_CONFIRMED",
        testFilePath: null,
        lastFailOutput: null,
        updatedAt: Date.now(),
      },
    ];
    const sidecar = makeMockSidecar({ tddStates, currentSpec: null });
    // Called with /my-project — should NOT see the other-project RED state
    const result = await handleCompactionAutocontinue(sidecar, "/my-project");
    expect(result.shouldContinue).toBe(true); // other project's RED doesn't block us
    expect(result.context).toEqual([]);
  });

  it("returns shouldContinue:true with empty context when spec is IN_PROGRESS but all tasks are complete", async () => {
    const spec: Spec = {
      id: "spec-done",
      title: "Completed Feature",
      status: "IN_PROGRESS",
      type: "feature",
      approved: true,
      planFile: "docs/plans/2026-03-01-done.md",
      tasks: [
        { position: 1, title: "Task A", status: "complete" },
        { position: 2, title: "Task B", status: "complete" },
      ],
      metadata: {},
    };
    const sidecar = makeMockSidecar({ tddStates: [], currentSpec: spec });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    // All tasks done — no currentTask, so idle fallthrough
    expect(result).toEqual({ shouldContinue: true, context: [] });
  });

  it("ignores TDD states that are not RED_CONFIRMED", async () => {
    const tddStates: TddCycle[] = [
      {
        id: 1,
        filePath: "/project/src/bar.ts", // matches projectPath "/project"
        specId: null,
        taskPosition: null,
        state: "TEST_WRITTEN",
        testFilePath: null,
        lastFailOutput: null,
        updatedAt: Date.now(),
      },
    ];
    const sidecar = makeMockSidecar({ tddStates, currentSpec: null });
    const result = await handleCompactionAutocontinue(sidecar, "/project");
    expect(result.shouldContinue).toBe(true);
    expect(result.context).toEqual([]);
  });
});
