import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
// NOTE: import the .ts source explicitly — a stale tracked sentinal.js
// artifact in this directory would otherwise shadow it in bun's resolution.
// NOTE: parseBinaryVersion / ensureDashboard helper tests moved to
// src/opencode/dashboard-ensure.test.ts — the helpers no longer live in (or
// export from) this module because OpenCode invokes every plugin-module
// export as a plugin factory (see src/opencode/plugin-exports.test.ts).
import { SentinalPlugin } from "./sentinal.ts";
import { ensureDashboard } from "../../../src/opencode/dashboard-ensure.js";
import { SidecarClient } from "../../../src/sidecar/client.js";
import { ObservationQueue } from "../../../src/sidecar/observation-queue.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plugin load smoke test.
 *
 * Regression guard for the v1.29.0 incident where the plugin referenced an
 * undefined `context` binding inside its init body. `bun build` does not
 * type-check and the root tsconfig only includes src/**, so a plain
 * ReferenceError at init silently killed the ENTIRE plugin in OpenCode
 * ("error=context is not defined failed to load plugin") — disabling the TDD
 * guard, memory observer, and all other handlers for the session.
 *
 * Calling the plugin function with a realistic mock context catches any
 * init-time throw at test time.
 */
describe("SentinalPlugin init (load smoke)", () => {
  function mockContext(overrides: Record<string, unknown> = {}) {
    return {
      project: { id: "test", worktree: "/tmp/sentinal-plugin-load-test" },
      client: {
        app: { log: async () => {} },
        session: { messages: async () => ({ data: [] }) },
      },
      $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      directory: "/tmp/sentinal-plugin-load-test",
      worktree: "/tmp/sentinal-plugin-load-test",
      ...overrides,
    } as never;
  }

  it("initializes without throwing and returns hook handlers", async () => {
    const hooks = await SentinalPlugin(mockContext());
    expect(hooks).toBeDefined();
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  }, 30_000);

  it("registers the workspace adaptor when experimental_workspace is available", async () => {
    const registered: Array<{ type: string; adaptor: unknown }> = [];
    await SentinalPlugin(
      mockContext({
        experimental_workspace: {
          register: (type: string, adaptor: unknown) =>
            registered.push({ type, adaptor }),
        },
      }),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]!.type).toBe("sentinal-spec-worktree");
  }, 30_000);

  it("initializes without experimental_workspace (older OpenCode)", async () => {
    const hooks = await SentinalPlugin(mockContext());
    expect(hooks).toBeDefined();
  }, 30_000);
});

// ─── ensureDashboard logic ────────────────────────────────────────────────────

describe("ensureDashboard", () => {
  it("should spawn when health probe returns null (not running)", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => null,
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(true);
  });

  it("should not spawn when same version is live", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.1", pid: 1234 }),
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(false);
  });

  it("should spawn when different version is live (serve handles takeover)", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.0", pid: 1234 }),
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(true);
  });

  it("should not throw when spawnFn throws", async () => {
    await expect(
      ensureDashboard({
        currentVersion: "1.30.1",
        probeFn: async () => null,
        spawnFn: () => {
          throw new Error("spawn failed");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── tool.execute hooks — SDK-true shapes (C1 regression) ─────────────────────
//
// Per the installed @opencode-ai/plugin types:
//   "tool.execute.before": (input: {tool, sessionID, callID},
//                           output: {args})                       ← args WRITABLE here
//   "tool.execute.after":  (input: {tool, sessionID, callID, args},
//                           output: {title, output, metadata})    ← args on INPUT
//
// The after-handler historically read `output.args` (always undefined), which
// left the quality gate, TDD transitions, and memory capture dead on OpenCode.
// These tests invoke the handlers with the SDK-true shapes and MUST fail if
// the after-handler reverts to reading `output.args` (mutation pin).
//
// OpenCode's shell tool (packages/opencode/src/tool/shell.ts) returns
// `metadata: { output, exit: code, truncated }` — exit info lives in
// `metadata.exit` and may be null (abort/timeout). The memory-capture
// success derivation must use it when numeric and degrade gracefully when
// absent.
describe("tool.execute hooks (SDK-true shapes)", () => {
  let tmpRoot: string;
  let queuePendingSpy: ReturnType<typeof spyOn>;
  let queueEnqueueSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sentinal-plugin-hooks-"));
    // Keep tests from draining/writing the REAL on-disk observation queue.
    queuePendingSpy = spyOn(ObservationQueue, "pending").mockReturnValue(0);
    queueEnqueueSpy = spyOn(ObservationQueue, "enqueue").mockImplementation(
      () => {},
    );
  });

  afterAll(() => {
    queuePendingSpy.mockRestore();
    queueEnqueueSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  interface FakeSidecarCalls {
    tddTransitions: string[];
    setTddStates: Array<Record<string, unknown>>;
    observations: Array<Record<string, unknown>>;
    tddStateResponse: { state: string; hasActiveSpec: boolean };
  }

  function makeFakeSidecar(): { fake: SidecarClient; calls: FakeSidecarCalls } {
    const calls: FakeSidecarCalls = {
      tddTransitions: [],
      setTddStates: [],
      observations: [],
      tddStateResponse: { state: "IDLE", hasActiveSpec: false },
    };
    const fake = {
      createSession: async () => {},
      endSession: async () => {},
      getTddState: async () => calls.tddStateResponse,
      setTddState: async (s: Record<string, unknown>) => {
        calls.setTddStates.push(s);
      },
      tddTransition: async (action: string) => {
        calls.tddTransitions.push(action);
        return { count: 1 };
      },
      addObservation: async (obs: Record<string, unknown>) => {
        calls.observations.push(obs);
      },
      memorySearch: async () => [],
    };
    return { fake: fake as unknown as SidecarClient, calls };
  }

  function mockContext(logs: string[]) {
    return {
      project: { name: "test", path: tmpRoot },
      client: {
        app: {
          log: async (opts: { body: { message: string } }) => {
            logs.push(opts.body.message);
          },
        },
        session: { messages: async () => ({ data: [] }) },
      },
      $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      directory: tmpRoot,
      worktree: tmpRoot,
    } as never;
  }

  /** Init the plugin with a stubbed sidecar connection. */
  async function initPlugin(fake: SidecarClient, logs: string[] = []) {
    const spy = spyOn(SidecarClient, "connectWithRetry").mockResolvedValue(
      fake,
    );
    try {
      return await SentinalPlugin(mockContext(logs));
    } finally {
      spy.mockRestore();
    }
  }

  /** Poll until cond() is true or timeout — for the fire-and-forget phase. */
  async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
    const start = Date.now();
    while (!cond() && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return cond();
  }

  function makeBigFile(path: string, lines = 650): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      Array.from({ length: lines }, () => "// line").join("\n"),
    );
    return path;
  }

  const afterOutput = (
    over: Partial<{
      title: string;
      output: string;
      metadata: Record<string, unknown>;
    }> = {},
  ) => ({ title: "", output: "", metadata: {}, ...over });

  it("after-handler blocks a 600+-line file via input.args (quality gate awakened)", async () => {
    const { fake } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const bigFile = makeBigFile(join(tmpRoot, "gate", "big-file.ts"));

    await expect(
      hooks["tool.execute.after"]!(
        {
          tool: "write",
          sessionID: "s1",
          callID: "c1",
          args: { filePath: bigFile },
        } as never,
        afterOutput({ title: "big-file.ts" }) as never,
      ),
    ).rejects.toThrow(/Blocking due to critical issues/);
  }, 30_000);

  it("after-handler quality gate covers multiedit", async () => {
    const { fake } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const bigFile = makeBigFile(join(tmpRoot, "gate-me", "big-file.ts"));

    await expect(
      hooks["tool.execute.after"]!(
        {
          tool: "multiedit",
          sessionID: "s1",
          callID: "c1",
          args: { filePath: bigFile },
        } as never,
        afterOutput() as never,
      ),
    ).rejects.toThrow(/Blocking due to critical issues/);
  }, 30_000);

  it("after-handler honours PATH_EXEMPTIONS (the plugin's own file never blocks)", async () => {
    const { fake } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const exemptFile = makeBigFile(
      join(tmpRoot, "targets", "opencode", "plugins", "sentinal.ts"),
    );

    await expect(
      hooks["tool.execute.after"]!(
        {
          tool: "write",
          sessionID: "s1",
          callID: "c1",
          args: { filePath: exemptFile },
        } as never,
        afterOutput() as never,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("before-handler reads WRITABLE output.args (TDD guard blocks IDLE impl edit)", async () => {
    const { fake, calls } = makeFakeSidecar();
    calls.tddStateResponse = { state: "IDLE", hasActiveSpec: true };
    const hooks = await initPlugin(fake);

    await expect(
      hooks["tool.execute.before"]!(
        { tool: "edit", sessionID: "s1", callID: "c1" } as never,
        { args: { filePath: join(tmpRoot, "src", "guarded.ts") } } as never,
      ),
    ).rejects.toThrow(/TDD Guard/);
  }, 30_000);

  it("before-handler hints on the real webfetch tool name", async () => {
    const { fake } = makeFakeSidecar();
    const logs: string[] = [];
    const hooks = await initPlugin(fake, logs);

    await hooks["tool.execute.before"]!(
      { tool: "webfetch", sessionID: "s1", callID: "c1" } as never,
      { args: { url: "https://example.com" } } as never,
    );

    expect(logs.some((m) => m.includes("web-fetch tool"))).toBe(true);
  }, 30_000);

  it("failing-test bash output (output.output) fires TEST_WRITTEN→RED_CONFIRMED", async () => {
    const { fake, calls } = makeFakeSidecar();
    const hooks = await initPlugin(fake);

    await hooks["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun test src/foo.test.ts" },
      } as never,
      afterOutput({
        title: "bun test",
        output: "1 tests failed\nexpect(received).toBe(expected)",
        metadata: { exit: 1 },
      }) as never,
    );

    expect(
      await until(() => calls.tddTransitions.includes("confirm_red")),
    ).toBe(true);
  }, 30_000);

  it("green bash output clears RED state (confirm_green)", async () => {
    const { fake, calls } = makeFakeSidecar();
    const hooks = await initPlugin(fake);

    await hooks["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun test" },
      } as never,
      afterOutput({
        title: "bun test",
        output: "All 12 tests passed",
        metadata: { exit: 0 },
      }) as never,
    );

    expect(
      await until(() => calls.tddTransitions.includes("confirm_green")),
    ).toBe(true);
  }, 30_000);

  it("memory capture derives bash success from metadata.exit when numeric", async () => {
    const { fake, calls } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const after = hooks["tool.execute.after"]!;

    // error bash (exit 1) then successful build bash (exit 0) → build-fix capture
    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun run build" },
      } as never,
      afterOutput({
        output: "ERROR: build failed with error TS2304",
        metadata: { exit: 1 },
      }) as never,
    );
    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "bun run build" },
      } as never,
      afterOutput({ output: "build success", metadata: { exit: 0 } }) as never,
    );

    expect(await until(() => calls.observations.length > 0)).toBe(true);
    expect(calls.observations[0]!.title).toBe("Build/lint issue resolved");
  }, 30_000);

  it("memory capture does NOT treat a non-zero metadata.exit as success", async () => {
    const { fake, calls } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const after = hooks["tool.execute.after"]!;

    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun run build" },
      } as never,
      afterOutput({
        output: "ERROR: build failed with error TS2304",
        metadata: { exit: 1 },
      }) as never,
    );
    // Success-looking TEXT but non-zero exit — success must come from metadata.
    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "bun run build" },
      } as never,
      afterOutput({ output: "build success", metadata: { exit: 1 } }) as never,
    );

    // Bounded wait: the capture must never fire when exit says failure.
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.observations.length).toBe(0);
  }, 30_000);

  it("memory capture degrades gracefully when metadata carries no exit info", async () => {
    const { fake, calls } = makeFakeSidecar();
    const hooks = await initPlugin(fake);
    const after = hooks["tool.execute.after"]!;

    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun run build" },
      } as never,
      afterOutput({ output: "ERROR: build failed with error TS2304" }) as never,
    );
    // No exit info anywhere → falls back to !asyncShouldBlock (true), no throw.
    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "bun run build" },
      } as never,
      afterOutput({ output: "build success" }) as never,
    );

    expect(await until(() => calls.observations.length > 0)).toBe(true);
    expect(calls.observations[0]!.title).toBe("Build/lint issue resolved");
  }, 30_000);
});
