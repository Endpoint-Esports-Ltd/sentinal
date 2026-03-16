/**
 * TDD MCP Tools Tests
 *
 * Tests for TDD guard management tools:
 *   - tdd_status: Get current TDD state for a file or list all active states
 *   - tdd_set_state: Set TDD cycle state for a file
 *   - tdd_clear: Clear TDD state for a file or spec
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { registerTddTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";

// --- Helpers ---

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `sentinal-tdd-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>;

function captureTools(deps: {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = new McpServer({ name: "test", version: "0.0.1" });

  const origTool = server.tool.bind(server);
  server.tool = ((...args: unknown[]) => {
    if (args.length >= 4 && typeof args[0] === "string") {
      const name = args[0] as string;
      const handler = args[3] as ToolHandler;
      tools.set(name, handler);
    }
    return origTool(...(args as Parameters<typeof origTool>));
  }) as typeof server.tool;

  registerTddTools(server, deps);
  return tools;
}

// --- Direct mode tests (no sidecar) ---

describe("TDD MCP tools (direct mode)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools({ store });
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

  it("tdd_status should list all active states when no file given", async () => {
    store.setTddState({ filePath: "/src/a.ts", state: "RED_CONFIRMED" });
    store.setTddState({ filePath: "/src/b.ts", state: "TEST_WRITTEN" });

    const handler = tools.get("tdd_status")!;
    const result = await handler({});
    expect(result.content[0].text).toContain("/src/a.ts");
    expect(result.content[0].text).toContain("/src/b.ts");
    expect(result.content[0].text).toContain("2 active");
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

    store.setTddState({
      filePath: "/src/a.ts",
      state: "RED_CONFIRMED",
      specId: "s1",
    });
    store.setTddState({
      filePath: "/src/b.ts",
      state: "TEST_WRITTEN",
      specId: "s2",
    });

    const handler = tools.get("tdd_status")!;
    const result = await handler({ spec_id: "s1" });
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
    expect(tdd?.specId).toBe("my-spec");
    expect(tdd?.testFilePath).toBe("/src/foo.test.ts");
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
      getTddState: async (filePath: string) => ({
        state: "RED_CONFIRMED",
        hasActiveSpec: true,
      }),
    } as unknown as SidecarClient;

    const tools = captureTools({ client: mockClient });
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

    const tools = captureTools({ client: mockClient });
    const handler = tools.get("tdd_status")!;
    const result = await handler({});
    expect(result.content[0].text).toContain("2 active");
  });

  it("tdd_set_state should delegate to client.setTddState", async () => {
    let calledWith: any = null;
    const mockClient = {
      setTddState: async (opts: any) => {
        calledWith = opts;
      },
    } as unknown as SidecarClient;

    const tools = captureTools({ client: mockClient });
    const handler = tools.get("tdd_set_state")!;
    await handler({ file_path: "/src/foo.ts", state: "RED_CONFIRMED" });

    expect(calledWith).not.toBeNull();
    expect(calledWith.filePath).toBe("/src/foo.ts");
    expect(calledWith.state).toBe("RED_CONFIRMED");
  });

  it("tdd_clear should delegate to client.clearTddState for file", async () => {
    const calls: string[] = [];
    const mockClient = {
      clearTddState: async (fp: string) => {
        calls.push(fp);
      },
    } as unknown as SidecarClient;

    const tools = captureTools({ client: mockClient });
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

    const tools = captureTools({ client: mockClient });
    const handler = tools.get("tdd_clear")!;
    await handler({ spec_id: "my-spec" });

    expect(calls).toEqual(["my-spec"]);
  });
});
