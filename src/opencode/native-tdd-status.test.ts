import { describe, it, expect } from "bun:test";
import { createTddStatusTool } from "./native-tdd-status.js";
import type { SidecarClient } from "../sidecar/client.js";

describe("createTddStatusTool", () => {
  it("should return a tool definition with correct description and args", () => {
    const tool = createTddStatusTool(null);
    expect(tool.description).toContain("TDD");
    expect(tool.args).toHaveProperty("file_path");
    expect(tool.args).toHaveProperty("spec_id");
    expect(typeof tool.execute).toBe("function");
  });

  it("should return unavailable message when sidecar is null", async () => {
    const tool = createTddStatusTool(null);
    const result = await tool.execute({}, { directory: "/project", worktree: "/project" });
    expect((result as { content: string }).content).toContain("unavailable");
    expect((result as { metadata: { sentinal: { tdd_state: string } } }).metadata.sentinal.tdd_state).toBe("IDLE");
  });

  it("should return file-specific TDD state in single file mode", async () => {
    const mockSidecar = {
      getTddState: async (_fp: string) => ({ state: "RED_CONFIRMED", hasActiveSpec: true }),
      listActiveTddStates: async () => [],
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    const result = await tool.execute(
      { file_path: "/src/foo.ts" },
      { directory: "/project", worktree: "/project" },
    ) as { content: string; metadata: { sentinal: { tdd_state: string } } };

    expect(result.content).toContain("/src/foo.ts");
    expect(result.content).toContain("RED_CONFIRMED");
    expect(result.content).toContain("active spec");
    expect(result.metadata.sentinal.tdd_state).toBe("RED_CONFIRMED");
  });

  it("should return all active TDD states in list mode", async () => {
    const mockSidecar = {
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      listActiveTddStates: async () => [
        { filePath: "/src/a.ts", state: "RED_CONFIRMED", updatedAt: Date.now() },
        { filePath: "/src/b.ts", state: "TEST_WRITTEN", updatedAt: Date.now() },
      ],
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    const result = await tool.execute(
      {},
      { directory: "/project", worktree: "/project" },
    ) as { content: string; metadata: { sentinal: { tdd_state: string; active_count: number } } };

    expect(result.metadata.sentinal.active_count).toBe(2);
    expect(result.content).toContain("/src/a.ts");
    expect(result.content).toContain("/src/b.ts");
    expect(result.metadata.sentinal.tdd_state).toBe("RED_CONFIRMED");
  });

  it("should return empty message when no active TDD cycles", async () => {
    const mockSidecar = {
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      listActiveTddStates: async () => [],
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    const result = await tool.execute(
      {},
      { directory: "/project", worktree: "/project" },
    ) as { content: string; metadata: { sentinal: { tdd_state: string; active_count: number } } };

    expect(result.content).toContain("No active TDD cycles");
    expect(result.metadata.sentinal.active_count).toBe(0);
    expect(result.metadata.sentinal.tdd_state).toBe("IDLE");
  });

  it("should filter by spec_id in list mode", async () => {
    const capturedArgs: Array<string | null | undefined> = [];
    const mockSidecar = {
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      listActiveTddStates: async (specId?: string | null) => {
        capturedArgs.push(specId);
        return [{ filePath: "/src/c.ts", state: "GREEN_CONFIRMED", updatedAt: Date.now() }];
      },
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    await tool.execute(
      { spec_id: "my-spec-id" },
      { directory: "/project", worktree: "/project" },
    );

    expect(capturedArgs[0]).toBe("my-spec-id");
  });
});
