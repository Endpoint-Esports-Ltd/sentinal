/**
 * Workspace Adaptor Tests
 *
 * Tests for the Sentinal Spec Worktree workspace adaptor.
 * All sidecar calls and executor invocations are mocked.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import type { SidecarClient } from "../sidecar/client.js";
import { createSpecWorktreeAdaptor } from "./workspace-adaptor.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type WorkspaceInfo = {
  id: string;
  type: string;
  name: string;
  branch: string | null;
  directory: string | null;
  extra: unknown | null;
  projectID: string;
};

function makeConfig(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws-1",
    type: "sentinal-spec-worktree",
    name: "",
    branch: null,
    directory: "/test/project",
    extra: null,
    projectID: "proj-1",
    ...overrides,
  };
}

function makeMockSidecar(
  overrides: Partial<SidecarClient> = {},
): SidecarClient {
  return {
    getCurrentSpec: mock(async () => null),
    resolveWorktreeBySlug: mock(async () => null),
    abandonWorktree: mock(async () => {}),
    ...overrides,
  } as unknown as SidecarClient;
}

// ─── configure() ──────────────────────────────────────────────────────────────

describe("createSpecWorktreeAdaptor — configure()", () => {
  it("should return config unchanged when no active spec and no compact-state", async () => {
    const sidecar = makeMockSidecar();
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig();
    const result = await adaptor.configure(config);
    expect(result).toEqual(config);
  });

  it("should pre-fill name from active spec plan slug via sidecar", async () => {
    const sidecar = makeMockSidecar({
      getCurrentSpec: mock(async (_p: string) => ({
        id: "2026-06-09-my-feature",
        title: "My Feature",
        status: "IN_PROGRESS" as "IN_PROGRESS",
        type: "Feature" as "Feature",
        approved: true,
        planFile: "/test/project/docs/plans/2026-06-09-my-feature.md",
        tasks: [],
        metadata: {},
        sessionId: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as unknown as SidecarClient["getCurrentSpec"],
    });
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig({ directory: "/test/project" });
    const result = await adaptor.configure(config);
    expect(result.name).toContain("2026-06-09-my-feature");
    expect((result.extra as { planPath: string }).planPath).toBe(
      "/test/project/docs/plans/2026-06-09-my-feature.md",
    );
  });

  it("should pre-fill name from compact-state.json when sidecar unavailable", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sentinalDir = join(tmpDir, ".sentinal");
      mkdirSync(sentinalDir, { recursive: true });
      writeFileSync(
        join(sentinalDir, "compact-state.json"),
        JSON.stringify({
          activePlan: "/test/project/docs/plans/2026-06-09-from-state.md",
          timestamp: new Date().toISOString(),
          cwd: tmpDir,
        }),
      );
      const adaptor = createSpecWorktreeAdaptor(null); // no sidecar
      const config = makeConfig({ directory: tmpDir });
      const result = await adaptor.configure(config);
      expect(result.name).toContain("2026-06-09-from-state");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should not throw when sidecar getCurrentSpec rejects", async () => {
    const sidecar = makeMockSidecar({
      getCurrentSpec: mock(async () => {
        throw new Error("sidecar down");
      }),
    });
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig();
    const result = await adaptor.configure(config);
    expect(result).toEqual(config); // returns original unchanged
  });
});

// ─── target() ─────────────────────────────────────────────────────────────────

describe("createSpecWorktreeAdaptor — target()", () => {
  it("should return worktree path when worktree exists for the slug", async () => {
    const sidecar = makeMockSidecar({
      resolveWorktreeBySlug: mock(async () => ({
        id: "wt-1",
        worktreePath: "/test/project/.sentinal/worktrees/spec-my-feature-abc1",
        branchName: "sentinal/spec-2026-06-09-my-feature",
        baseBranch: "main",
        projectPath: "/test/project",
        status: "active" as const,
        baseCommit: "abc123",
        createdAt: Date.now(),
      })),
    });
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig({
      extra: { planPath: "/test/project/docs/plans/2026-06-09-my-feature.md" },
      directory: "/test/project",
    });
    const result = await adaptor.target(config);
    expect(result.type).toBe("local");
    expect((result as { type: string; directory: string }).directory).toBe(
      "/test/project/.sentinal/worktrees/spec-my-feature-abc1",
    );
  });

  it("should fall back to project directory when no worktree found", async () => {
    const sidecar = makeMockSidecar({
      resolveWorktreeBySlug: mock(async () => null),
    });
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig({
      extra: { planPath: "/test/project/docs/plans/2026-06-09-my-feature.md" },
      directory: "/test/project",
    });
    const result = await adaptor.target(config);
    expect(result.type).toBe("local");
    expect((result as { type: string; directory: string }).directory).toBe(
      "/test/project",
    );
  });

  it("should fall back to . when no directory in config", async () => {
    const adaptor = createSpecWorktreeAdaptor(null);
    const config = makeConfig({ directory: null, extra: null });
    const result = await adaptor.target(config);
    expect(result.type).toBe("local");
    expect((result as { type: string; directory: string }).directory).toBe(".");
  });
});

// ─── create() ─────────────────────────────────────────────────────────────────

describe("createSpecWorktreeAdaptor — create()", () => {
  it("should call executor with sentinal worktree create command", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const executor = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
    };
    const adaptor = createSpecWorktreeAdaptor(null, executor);
    const config = makeConfig({
      extra: { planPath: "/test/project/docs/plans/2026-06-09-my-feature.md" },
      directory: "/test/project",
    });
    await adaptor.create(config);
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe("sentinal");
    expect(calls[0].args).toContain("worktree");
    expect(calls[0].args).toContain("create");
    expect(calls[0].args.join(" ")).toContain("2026-06-09-my-feature");
  });

  it("should not throw when executor throws (non-fatal)", async () => {
    const executor = (_cmd: string, _args: string[]) => {
      throw new Error("sentinal not in PATH");
    };
    const adaptor = createSpecWorktreeAdaptor(null, executor);
    const config = makeConfig({ extra: { planPath: "/test/plans/plan.md" } });
    expect(adaptor.create(config)).resolves.toBeUndefined();
  });

  it("should skip execution when no planSlug can be derived", async () => {
    const calls: unknown[] = [];
    const executor = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
    };
    const adaptor = createSpecWorktreeAdaptor(null, executor);
    const config = makeConfig({ extra: null, name: "" });
    await adaptor.create(config);
    expect(calls.length).toBe(0);
  });
});

// ─── remove() ─────────────────────────────────────────────────────────────────

describe("createSpecWorktreeAdaptor — remove()", () => {
  it("should call sidecar abandonWorktree when worktree found", async () => {
    const abandonFn = mock(async () => {});
    const sidecar = makeMockSidecar({
      resolveWorktreeBySlug: mock(async () => ({
        id: "wt-remove-1",
        worktreePath: "/test/.sentinal/worktrees/spec-plan-abc1",
        branchName: "sentinal/spec-plan",
        baseBranch: "main",
        projectPath: "/test",
        status: "active" as const,
        baseCommit: "abc",
        createdAt: Date.now(),
      })),
      abandonWorktree: abandonFn,
    });
    const adaptor = createSpecWorktreeAdaptor(sidecar);
    const config = makeConfig({
      extra: { planPath: "/test/docs/plans/plan.md" },
      directory: "/test",
    });
    await adaptor.remove(config);
    expect(abandonFn).toHaveBeenCalledTimes(1);
  });

  it("should not throw when no worktree found", async () => {
    const adaptor = createSpecWorktreeAdaptor(null);
    const config = makeConfig({ extra: null });
    expect(adaptor.remove(config)).resolves.toBeUndefined();
  });
});
