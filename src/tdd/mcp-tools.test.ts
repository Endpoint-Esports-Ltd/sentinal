/**
 * TDD MCP Tools Tests
 *
 * Tests for TDD guard management tools:
 *   - tdd_status: Get current TDD state for a file or list all active states
 *   - tdd_set_state: Set TDD cycle state for a file
 *   - tdd_clear: Clear TDD state for a file or spec
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { registerTddTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";

// --- Direct mode tests (no sidecar) ---

describe("TDD MCP tools (direct mode)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerTddTools, { store });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Registration ---

  it("should register all 3 tools", () => {
    expect(tools.has("tdd_status")).toBe(true);
    expect(tools.has("tdd_set_state")).toBe(true);
    expect(tools.has("tdd_clear")).toBe(true);
  });

  // --- tdd_status ---

  it("tdd_status should return IDLE for unknown file", async () => {
    const handler = tools.get("tdd_status")!;
    const result = await handler({ file_path: "/src/unknown.ts" });
    expect(result.content[0].text).toContain("IDLE");
  });

  it("tdd_status should return state for a known file", async () => {
    store.setTddState({ filePath: "/src/foo.ts", state: "RED_CONFIRMED" });

    const handler = tools.get("tdd_status")!;
    const result = await handler({ file_path: "/src/foo.ts" });
    expect(result.content[0].text).toContain("RED_CONFIRMED");
    expect(result.content[0].text).toContain("/src/foo.ts");
  });

  it("tdd_status should list all active states in the project when no file given", async () => {
    const identity = resolveProjectIdentity(tmpDir);
    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      projectPath: identity,
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      projectPath: identity,
    });

    const handler = tools.get("tdd_status")!;
    const result = await handler({ project: tmpDir });
    expect(result.content[0].text).toContain("/src/a.ts");
    expect(result.content[0].text).toContain("/src/b.ts");
    expect(result.content[0].text).toContain("2 active");
  });

  // --- tdd_status project scoping (Task 10, direct/store path) ---

  it("tdd_status excludes other projects' cycles when no spec id is given", async () => {
    store.setTddState({
      filePath: "/src/mine.ts",
      state: "RED_CONFIRMED",
      projectPath: resolveProjectIdentity(tmpDir),
    });
    store.setTddState({
      filePath: "/other/src/theirs.ts",
      state: "TEST_WRITTEN",
      projectPath: "/other/project",
    });
    store.setTddState({
      filePath: "/legacy/unscoped.ts",
      state: "TEST_WRITTEN",
    });

    const handler = tools.get("tdd_status")!;
    const text = (await handler({ project: tmpDir })).content[0].text;
    expect(text).toContain("/src/mine.ts");
    expect(text).not.toContain("theirs.ts");
    expect(text).not.toContain("unscoped.ts");
    expect(text).toContain("1 active");
  });

  it("tdd_status normalizes project via resolveProjectIdentity (subdirectory resolves to the same key)", async () => {
    const sub = join(tmpDir, "nested");
    mkdirSync(sub, { recursive: true });
    // Outside a git repo identity falls back to the realpath of the dir itself,
    // so a raw-string compare of the macOS /var vs /private/var tmpdir would
    // miss; identity resolution must be applied to the argument.
    store.setTddState({
      filePath: "/src/real.ts",
      state: "RED_CONFIRMED",
      projectPath: resolveProjectIdentity(sub),
    });

    const handler = tools.get("tdd_status")!;
    const text = (await handler({ project: sub })).content[0].text;
    expect(text).toContain("/src/real.ts");
  });

  it("tdd_status defaults project to process.cwd() identity", async () => {
    store.setTddState({
      filePath: "/src/cwd-row.ts",
      state: "RED_CONFIRMED",
      projectPath: resolveProjectIdentity(process.cwd()),
    });
    store.setTddState({
      filePath: "/src/elsewhere.ts",
      state: "RED_CONFIRMED",
      projectPath: "/other/project",
    });

    const handler = tools.get("tdd_status")!;
    const text = (await handler({})).content[0].text;
    expect(text).toContain("cwd-row.ts");
    expect(text).not.toContain("elsewhere.ts");
  });

  it("tdd_status should filter by spec_id", async () => {
    // Create specs for FK constraint
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "s1.md"),
      "# S1\n\nStatus: PENDING\nType: Feature\n",
    );
    writeFileSync(
      join(plansDir, "s2.md"),
      "# S2\n\nStatus: PENDING\nType: Feature\n",
    );
    const specStore = new SpecStore(store);
    specStore.syncFromPlanFile(join(plansDir, "s1.md"), tmpDir);
    specStore.syncFromPlanFile(join(plansDir, "s2.md"), tmpDir);

    const identity = resolveProjectIdentity(tmpDir);
    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "s1",
      projectPath: identity,
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "s2",
      projectPath: identity,
    });

    const handler = tools.get("tdd_status")!;
    const result = await handler({ spec_id: "s1", project: tmpDir });
    expect(result.content[0].text).toContain("/src/a.ts");
    expect(result.content[0].text).not.toContain("/src/b.ts");
    expect(result.content[0].text).toContain("1 active");
  });

  // --- tdd_set_state ---

  it("tdd_set_state should set RED_CONFIRMED for a file", async () => {
    const handler = tools.get("tdd_set_state")!;
    const result = await handler({
      file_path: "/src/foo.ts",
      state: "RED_CONFIRMED",
    });
    expect(result.content[0].text).toContain("Set");
    expect(result.content[0].text).toContain("RED_CONFIRMED");

    const tdd = store.getTddState("/src/foo.ts");
    expect(tdd?.state).toBe("RED_CONFIRMED");
  });

  it("tdd_set_state should set state with spec_id and test_file_path", async () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "my-spec.md"),
      "# My Spec\n\nStatus: PENDING\nType: Feature\n",
    );
    const specStore = new SpecStore(store);
    specStore.syncFromPlanFile(join(plansDir, "my-spec.md"), tmpDir);

    const handler = tools.get("tdd_set_state")!;
    await handler({
      file_path: "/src/foo.ts",
      state: "TEST_WRITTEN",
      spec_id: "my-spec",
      test_file_path: "/src/foo.test.ts",
    });

    const tdd = store.getTddState("/src/foo.ts");
    expect(tdd?.state).toBe("TEST_WRITTEN");
    // D6: the stored FK is the project-qualified key the slug resolved to.
    expect(tdd?.specId).toEndWith("::my-spec");
    expect(tdd?.testFilePath).toBe("/src/foo.test.ts");
  });

  // --- tdd_set_state project (Task 8 scope addition, direct/store path) ---
  // A NULL-project RED row is never cleared by the project-scoped
  // confirm_green, leaving the file in the guard's BYPASS state forever.

  it("tdd_set_state records the canonical identity of the given project", async () => {
    const sub = join(tmpDir, "nested");
    mkdirSync(sub, { recursive: true });

    await tools.get("tdd_set_state")!({
      file_path: "/src/proj.ts",
      state: "RED_CONFIRMED",
      project: sub,
    });

    const row = store.getTddState("/src/proj.ts");
    expect(row?.projectPath).toBe(resolveProjectIdentity(sub));
    // Canonical, not the raw argument (macOS /var → /private/var realpath).
    expect(row?.projectPath).not.toBeNull();
  });

  it("tdd_set_state defaults the project to process.cwd() identity (never NULL)", async () => {
    await tools.get("tdd_set_state")!({
      file_path: "/src/default.ts",
      state: "RED_CONFIRMED",
    });

    expect(store.getTddState("/src/default.ts")?.projectPath).toBe(
      resolveProjectIdentity(process.cwd()),
    );
  });

  // --- tdd_clear ---

  it("tdd_clear should clear state for a specific file", async () => {
    store.setTddState({ filePath: "/src/foo.ts", state: "RED_CONFIRMED" });

    const handler = tools.get("tdd_clear")!;
    const result = await handler({ file_path: "/src/foo.ts" });
    expect(result.content[0].text).toContain("Cleared");

    const tdd = store.getTddState("/src/foo.ts");
    expect(tdd).toBeNull();
  });

  it("tdd_clear should clear all states for a spec", async () => {
    const plansDir = join(tmpDir, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "clear-spec.md"),
      "# Clear Spec\n\nStatus: PENDING\nType: Feature\n",
    );
    const specStore = new SpecStore(store);
    specStore.syncFromPlanFile(join(plansDir, "clear-spec.md"), tmpDir);

    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "clear-spec",
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "clear-spec",
    });

    const handler = tools.get("tdd_clear")!;
    const result = await handler({ spec_id: "clear-spec" });
    expect(result.content[0].text).toContain("Cleared");

    const states = store.listActiveTddStates("clear-spec");
    expect(states.length).toBe(0);
  });

  it("tdd_clear should error when neither file_path nor spec_id given", async () => {
    const handler = tools.get("tdd_clear")!;
    const result = await handler({});
    expect(result.content[0].text).toContain("Error");
    expect(result.content[0].text).toContain("file_path or spec_id");
  });
});

// --- Sidecar mode tests (mock client) ---

describe("TDD MCP tools (sidecar mode)", () => {
  it("tdd_status should delegate to client.getTddState for single file", async () => {
    const mockClient = {
      getTddState: async (_filePath: string) => ({
        state: "RED_CONFIRMED",
        hasActiveSpec: true,
      }),
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const handler = tools.get("tdd_status")!;
    const result = await handler({ file_path: "/src/foo.ts" });
    expect(result.content[0].text).toContain("RED_CONFIRMED");
  });

  it("tdd_status should delegate to client.listActiveTddStates for list", async () => {
    const mockClient = {
      listActiveTddStates: async () => [
        {
          filePath: "/src/a.ts",
          state: "RED_CONFIRMED",
          updatedAt: Date.now(),
        },
        { filePath: "/src/b.ts", state: "TEST_WRITTEN", updatedAt: Date.now() },
      ],
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const handler = tools.get("tdd_status")!;
    const result = await handler({});
    expect(result.content[0].text).toContain("2 active");
  });

  it("tdd_status sends the project identity with spec_id (D6)", async () => {
    const calls: unknown[][] = [];
    const mockClient = {
      listActiveTddStates: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    } as unknown as SidecarClient;
    const dir = makeTmpDir();
    try {
      const tools = captureTools(registerTddTools, { client: mockClient });
      await tools.get("tdd_status")!({ spec_id: "shared-slug", project: dir });
      expect(calls[0]).toEqual(["shared-slug", resolveProjectIdentity(dir)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- tdd_status project scoping (Task 10, client/sidecar path) ---
  // Production runs with store: null, so this is the path agents actually hit.
  // The route cannot take a project yet, so the tool filters client-side.

  it("tdd_status scopes client results to the project identity", async () => {
    const dir = makeTmpDir();
    try {
      const identity = resolveProjectIdentity(dir);
      const mockClient = {
        listActiveTddStates: async () => [
          {
            filePath: "/src/mine.ts",
            state: "RED_CONFIRMED",
            updatedAt: Date.now(),
            projectPath: identity,
          },
          {
            filePath: "/src/theirs.ts",
            state: "TEST_WRITTEN",
            updatedAt: Date.now(),
            projectPath: "/other/project",
          },
          {
            filePath: "/src/unscoped.ts",
            state: "TEST_WRITTEN",
            updatedAt: Date.now(),
            projectPath: null,
          },
        ],
      } as unknown as SidecarClient;

      const tools = captureTools(registerTddTools, { client: mockClient });
      const text = (await tools.get("tdd_status")!({ project: dir })).content[0]
        .text;
      expect(text).toContain("mine.ts");
      expect(text).not.toContain("theirs.ts");
      expect(text).not.toContain("unscoped.ts");
      expect(text).toContain("1 active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tdd_status keeps client rows with no projectPath field (pre-V13 sidecar fails OPEN)", async () => {
    const mockClient = {
      listActiveTddStates: async () => [
        {
          filePath: "/src/old.ts",
          state: "TEST_WRITTEN",
          updatedAt: Date.now(),
        },
      ],
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const text = (await tools.get("tdd_status")!({ project: "/somewhere" }))
      .content[0].text;
    expect(text).toContain("old.ts");
  });

  it("tdd_status exposes an optional project param documented as the scope", () => {
    const server = {
      schemas: new Map<string, { desc: string; shape: Record<string, any> }>(),
      tool(name: string, desc: string, shape: Record<string, any>) {
        this.schemas.set(name, { desc, shape });
      },
    };
    registerTddTools(server as any, { client: {} as SidecarClient });
    const s = server.schemas.get("tdd_status")!;
    expect(Object.keys(s.shape)).toContain("project");
    expect(s.shape.project.isOptional()).toBe(true);
    expect(s.desc).toContain("current project");
    expect(s.shape.file_path.description).toContain("current project");
  });

  it("tdd_set_state should delegate to client.setTddState", async () => {
    let calledWith: any = null;
    const mockClient = {
      setTddState: async (opts: any) => {
        calledWith = opts;
      },
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const handler = tools.get("tdd_set_state")!;
    await handler({ file_path: "/src/foo.ts", state: "RED_CONFIRMED" });

    expect(calledWith).not.toBeNull();
    expect(calledWith.filePath).toBe("/src/foo.ts");
    expect(calledWith.state).toBe("RED_CONFIRMED");
  });

  // Production takes THIS path (store is null whenever the sidecar runs).
  it("tdd_set_state sends the canonical project identity to the sidecar", async () => {
    const dir = makeTmpDir();
    try {
      const sub = join(dir, "nested");
      mkdirSync(sub, { recursive: true });
      let calledWith: any = null;
      const mockClient = {
        setTddState: async (opts: any) => {
          calledWith = opts;
        },
      } as unknown as SidecarClient;

      const tools = captureTools(registerTddTools, { client: mockClient });
      await tools.get("tdd_set_state")!({
        file_path: "/src/foo.ts",
        state: "RED_CONFIRMED",
        project: sub,
      });

      expect(calledWith.projectPath).toBe(resolveProjectIdentity(sub));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tdd_set_state defaults the sidecar project to process.cwd() identity", async () => {
    let calledWith: any = null;
    const mockClient = {
      setTddState: async (opts: any) => {
        calledWith = opts;
      },
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    await tools.get("tdd_set_state")!({
      file_path: "/src/foo.ts",
      state: "RED_CONFIRMED",
    });

    expect(calledWith.projectPath).toBe(resolveProjectIdentity(process.cwd()));
  });

  it("tdd_set_state exposes an optional project param", () => {
    const server = {
      schemas: new Map<string, { desc: string; shape: Record<string, any> }>(),
      tool(name: string, desc: string, shape: Record<string, any>) {
        this.schemas.set(name, { desc, shape });
      },
    };
    registerTddTools(server as any, { client: {} as SidecarClient });
    const s = server.schemas.get("tdd_set_state")!;
    expect(Object.keys(s.shape)).toContain("project");
    expect(s.shape.project.isOptional()).toBe(true);
  });

  it("tdd_clear should delegate to client.clearTddState for file", async () => {
    const calls: string[] = [];
    const mockClient = {
      clearTddState: async (fp: string) => {
        calls.push(fp);
      },
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const handler = tools.get("tdd_clear")!;
    await handler({ file_path: "/src/foo.ts" });

    expect(calls).toEqual(["/src/foo.ts"]);
  });

  it("tdd_clear should delegate to client.clearTddStatesForSpec for spec", async () => {
    const calls: string[] = [];
    const mockClient = {
      clearTddStatesForSpec: async (id: string) => {
        calls.push(id);
      },
    } as unknown as SidecarClient;

    const tools = captureTools(registerTddTools, { client: mockClient });
    const handler = tools.get("tdd_clear")!;
    await handler({ spec_id: "my-spec" });

    expect(calls).toEqual(["my-spec"]);
  });
});
