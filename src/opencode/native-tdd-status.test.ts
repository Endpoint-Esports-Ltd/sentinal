import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTddStatusTool } from "./native-tdd-status.js";
import { resolveProjectIdentity } from "../project/identity.js";
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
    const result = await tool.execute(
      {},
      { directory: "/project", worktree: "/project" },
    );
    expect((result as { content: string }).content).toContain("unavailable");
    expect(
      (result as { metadata: { sentinal: { tdd_state: string } } }).metadata
        .sentinal.tdd_state,
    ).toBe("IDLE");
  });

  it("should return file-specific TDD state in single file mode", async () => {
    const mockSidecar = {
      getTddState: async (_fp: string) => ({
        state: "RED_CONFIRMED",
        hasActiveSpec: true,
      }),
      listActiveTddStates: async () => [],
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    const result = (await tool.execute(
      { file_path: "/src/foo.ts" },
      { directory: "/project", worktree: "/project" },
    )) as { content: string; metadata: { sentinal: { tdd_state: string } } };

    expect(result.content).toContain("/src/foo.ts");
    expect(result.content).toContain("RED_CONFIRMED");
    expect(result.content).toContain("active spec");
    expect(result.metadata.sentinal.tdd_state).toBe("RED_CONFIRMED");
  });

  it("should return all active TDD states in list mode", async () => {
    const mockSidecar = {
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      listActiveTddStates: async () => [
        {
          filePath: "/src/a.ts",
          state: "RED_CONFIRMED",
          updatedAt: Date.now(),
        },
        { filePath: "/src/b.ts", state: "TEST_WRITTEN", updatedAt: Date.now() },
      ],
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    const result = (await tool.execute(
      {},
      { directory: "/project", worktree: "/project" },
    )) as {
      content: string;
      metadata: { sentinal: { tdd_state: string; active_count: number } };
    };

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
    const result = (await tool.execute(
      {},
      { directory: "/project", worktree: "/project" },
    )) as {
      content: string;
      metadata: { sentinal: { tdd_state: string; active_count: number } };
    };

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
        return [
          {
            filePath: "/src/c.ts",
            state: "GREEN_CONFIRMED",
            updatedAt: Date.now(),
          },
        ];
      },
    } as unknown as SidecarClient;

    const tool = createTddStatusTool(mockSidecar);
    await tool.execute(
      { spec_id: "my-spec-id" },
      { directory: "/project", worktree: "/project" },
    );

    expect(capturedArgs[0]).toBe("my-spec-id");
  });

  // ─── Project scoping (Task 10) ─────────────────────────────────────────
  // The sidecar route cannot be scoped from here, so the tool filters the
  // fetched rows itself. Rows are keyed by the project IDENTITY (the storage
  // key), so the filter must resolve context.directory through
  // resolveProjectIdentity, not compare it raw.

  describe("project scoping", () => {
    let dir: string;
    let identity: string;

    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "native-tdd-scope-")));
      identity = resolveProjectIdentity(dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function sidecarReturning(rows: unknown[]): SidecarClient {
      return {
        getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
        listActiveTddStates: async () => rows,
      } as unknown as SidecarClient;
    }

    type ListResult = {
      content: string;
      metadata: { sentinal: { tdd_state: string; active_count: number } };
    };

    it("reports only the current project's cycles when no spec id is given", async () => {
      const tool = createTddStatusTool(
        sidecarReturning([
          {
            filePath: `${dir}/src/mine.ts`,
            state: "RED_CONFIRMED",
            updatedAt: Date.now(),
            projectPath: identity,
          },
          {
            filePath: "/other/project/src/theirs.ts",
            state: "TEST_WRITTEN",
            updatedAt: Date.now(),
            projectPath: "/other/project",
          },
        ]),
      );
      const result = (await tool.execute(
        {},
        { directory: dir, worktree: dir },
      )) as ListResult;

      expect(result.content).toContain("mine.ts");
      expect(result.content).not.toContain("theirs.ts");
      expect(result.metadata.sentinal.active_count).toBe(1);
      expect(result.metadata.sentinal.tdd_state).toBe("RED_CONFIRMED");
    });

    it("resolves context.directory to the project identity (subdirectory of a repo matches the repo key)", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const sub = join(dir, "packages", "app");
      mkdirSync(sub, { recursive: true });
      const repoKey = resolveProjectIdentity(dir);
      expect(repoKey).not.toBe(sub); // the test is only meaningful if they differ

      const tool = createTddStatusTool(
        sidecarReturning([
          {
            filePath: `${dir}/src/mine.ts`,
            state: "RED_CONFIRMED",
            updatedAt: Date.now(),
            projectPath: repoKey,
          },
        ]),
      );
      const result = (await tool.execute(
        {},
        { directory: sub, worktree: dir },
      )) as ListResult;

      expect(result.content).toContain("mine.ts");
      expect(result.metadata.sentinal.active_count).toBe(1);
    }, 15_000);

    it("also scopes when a spec id is given", async () => {
      const tool = createTddStatusTool(
        sidecarReturning([
          {
            filePath: "/other/project/src/theirs.ts",
            state: "TEST_WRITTEN",
            updatedAt: Date.now(),
            projectPath: "/other/project",
          },
        ]),
      );
      const result = (await tool.execute(
        { spec_id: "shared-slug" },
        { directory: dir, worktree: dir },
      )) as ListResult;

      expect(result.content).toContain("No active TDD cycles");
      expect(result.metadata.sentinal.active_count).toBe(0);
    });

    it("excludes rows the sidecar reports as unscoped (projectPath: null), matching the store", async () => {
      const tool = createTddStatusTool(
        sidecarReturning([
          {
            filePath: "/legacy/src/unscoped.ts",
            state: "RED_CONFIRMED",
            updatedAt: Date.now(),
            projectPath: null,
          },
        ]),
      );
      const result = (await tool.execute(
        {},
        { directory: dir, worktree: dir },
      )) as ListResult;

      expect(result.content).not.toContain("unscoped.ts");
      expect(result.metadata.sentinal.active_count).toBe(0);
    });

    it("fails OPEN for rows with no projectPath field at all (pre-V13 sidecar, per D6)", async () => {
      const tool = createTddStatusTool(
        sidecarReturning([
          {
            filePath: "/src/old-sidecar.ts",
            state: "TEST_WRITTEN",
            updatedAt: Date.now(),
          },
        ]),
      );
      const result = (await tool.execute(
        {},
        { directory: dir, worktree: dir },
      )) as ListResult;

      expect(result.content).toContain("old-sidecar.ts");
      expect(result.metadata.sentinal.active_count).toBe(1);
    });

    it("documents the project-scoped default in the file_path description", () => {
      const tool = createTddStatusTool(null);
      const desc = tool.args.file_path.description ?? "";
      expect(desc).toContain("current project");
      expect(tool.description).toContain("current project");
    });
  });
});
