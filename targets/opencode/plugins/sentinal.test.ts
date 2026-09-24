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
import { resolvePluginRoots } from "./sentinal-helpers.js";
import * as fileLogModule from "../../../src/utils/file-log.js";
import { PLUGIN_LOG_FILE, readLastLines } from "../../../src/utils/file-log.js";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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

// ─── Worktree-aware project roots ─────────────────────────────────────────────
//
// The plugin has to answer TWO different questions and must never conflate them:
//
//   • identity  → the CANONICAL project key (main checkout), used for every
//     sidecar storage key. `projectRoot ?? ""` previously wrote 14 empty-key
//     rows into the live DB, and a linked worktree keyed its observations under
//     its own path — invisible from the main checkout.
//   • workspace → the LOCAL checkout root, used for filesystem reads and for
//     plan discovery. The session.idle stop-guard is DELIBERATELY worktree-local
//     (docs/plans/2026-06-10-multi-plan-session-tracking.md:60-66) so two
//     sessions in two worktrees don't block on each other's plans.
//
// The fixture below builds a real git repo + linked worktree so identity and
// workspace provably DIFFER; asserting against the sentinal checkout itself
// would silently degenerate to a tautology on a plain clone (e.g. CI).
describe("worktree-aware project roots", () => {
  let fixtureRoot: string;
  let mainRoot: string;
  let linkedRoot: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

  const IN_PROGRESS_PLAN = [
    "# Fixture Plan",
    "",
    "**Status:** IN_PROGRESS",
    "**Type:** feature",
    "",
  ].join("\n");

  /** Remove every plan dir, then plant one IN_PROGRESS plan under `root`. */
  function onlyPlanIn(root: string): void {
    for (const r of [mainRoot, linkedRoot]) {
      rmSync(join(r, "docs"), { recursive: true, force: true });
    }
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(root, "docs", "plans", "2026-09-23-fixture.md"),
      IN_PROGRESS_PLAN,
    );
  }

  beforeAll(() => {
    fixtureRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "sentinal-roots-fixture-")),
    );
    mainRoot = join(fixtureRoot, "main");
    linkedRoot = join(fixtureRoot, "linked");
    mkdirSync(mainRoot, { recursive: true });

    git(mainRoot, "init", "-q", "-b", "main");
    git(mainRoot, "config", "user.email", "fixture@example.com");
    git(mainRoot, "config", "user.name", "Fixture");
    writeFileSync(join(mainRoot, "README.md"), "fixture\n");
    git(mainRoot, "add", ".");
    git(mainRoot, "commit", "-q", "-m", "init");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", linkedRoot);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // ── helper contract ────────────────────────────────────────────────────────

  it("resolves identity to the MAIN checkout and workspace to the LINKED worktree", () => {
    const roots = resolvePluginRoots(linkedRoot, linkedRoot);
    expect(roots.identity).toBe(mainRoot);
    expect(roots.workspace).toBe(linkedRoot);
    expect(roots.identity).not.toBe(roots.workspace);
    // The validated writable root is still the local checkout.
    expect(roots.root).toBe(linkedRoot);
  });

  it("never yields an empty project key, even when no writable root is found", () => {
    const roots = resolvePluginRoots("/", "/", {
      cwd: () => "/",
      exists: () => false,
      isWritable: () => false,
    });
    expect(roots.root).toBeNull();
    expect(roots.reason).toBeTruthy();
    expect(roots.identity).not.toBe("");
    expect(roots.identity.length).toBeGreaterThan(0);
    expect(roots.workspace).not.toBe("");
    expect(roots.workspace.length).toBeGreaterThan(0);
  });

  // ── plugin wiring ──────────────────────────────────────────────────────────

  interface RootsFake {
    fake: SidecarClient;
    createdProjectPaths: string[];
    currentSpecProjects: string[];
    setTddStates: Array<Record<string, unknown>>;
    tddTransitions: unknown[][];
    /** Rows returned by listActiveTddStates (compaction's disk filter input). */
    activeCycles: Array<{ filePath: string; state: string }>;
    /** When set, setTddState rejects with this error. */
    setTddStateError: Error | null;
    /** Rows returned by listSessionNotifications. */
    sessionNotifications: Array<Record<string, unknown>>;
    /** Every project passed to listSessionNotifications. */
    notificationListCalls: string[];
    /** Every id passed to markNotificationRead. */
    markedRead: number[];
    /** When set, listSessionNotifications rejects (e.g. an old sidecar 404). */
    listNotificationsError: Error | null;
  }

  function makeRootsFake(): RootsFake {
    const createdProjectPaths: string[] = [];
    const currentSpecProjects: string[] = [];
    const rf = {
      setTddStates: [] as Array<Record<string, unknown>>,
      tddTransitions: [] as unknown[][],
      activeCycles: [] as Array<{ filePath: string; state: string }>,
      setTddStateError: null as Error | null,
      sessionNotifications: [] as Array<Record<string, unknown>>,
      notificationListCalls: [] as string[],
      markedRead: [] as number[],
      listNotificationsError: null as Error | null,
    };
    const fake = {
      createSession: async (s: { projectPath: string }) => {
        createdProjectPaths.push(s.projectPath);
      },
      endSession: async () => {},
      touchSession: async () => {},
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      setTddState: async (s: Record<string, unknown>) => {
        if (rf.setTddStateError) throw rf.setTddStateError;
        rf.setTddStates.push(s);
      },
      tddTransition: async (...args: unknown[]) => {
        rf.tddTransitions.push(args);
        return { count: 0 };
      },
      listActiveTddStates: async () => rf.activeCycles,
      addObservation: async () => {},
      memorySearch: async () => [],
      getActiveSessions: async () => [],
      restoreContext: async () => ({ hasMemory: false, markdown: "" }),
      getCurrentSpec: async (project: string) => {
        currentSpecProjects.push(project);
        return null;
      },
      isSessionAlive: async () => false,
      getModelRouting: async () => ({
        planning: "opus",
        implementation: "sonnet",
        verification: "sonnet",
        plan_reviewer: "sonnet",
        spec_reviewer: "sonnet",
      }),
      listSessionNotifications: async (project: string) => {
        rf.notificationListCalls.push(project);
        if (rf.listNotificationsError) throw rf.listNotificationsError;
        return rf.sessionNotifications;
      },
      markNotificationRead: async (id: number) => {
        rf.markedRead.push(id);
      },
    };
    // Getters/setters over `rf` so tests can mutate after construction.
    return {
      fake: fake as unknown as SidecarClient,
      createdProjectPaths,
      currentSpecProjects,
      get setTddStates() {
        return rf.setTddStates;
      },
      get tddTransitions() {
        return rf.tddTransitions;
      },
      get activeCycles() {
        return rf.activeCycles;
      },
      set activeCycles(v) {
        rf.activeCycles = v;
      },
      get setTddStateError() {
        return rf.setTddStateError;
      },
      set setTddStateError(v) {
        rf.setTddStateError = v;
      },
      get sessionNotifications() {
        return rf.sessionNotifications;
      },
      set sessionNotifications(v) {
        rf.sessionNotifications = v;
      },
      get notificationListCalls() {
        return rf.notificationListCalls;
      },
      get markedRead() {
        return rf.markedRead;
      },
      get listNotificationsError() {
        return rf.listNotificationsError;
      },
      set listNotificationsError(v) {
        rf.listNotificationsError = v;
      },
    };
  }

  async function initAt(
    root: string,
    fake: SidecarClient,
    logs: string[],
  ): Promise<Record<string, (...a: never[]) => Promise<unknown>>> {
    const spy = spyOn(SidecarClient, "connectWithRetry").mockResolvedValue(
      fake,
    );
    try {
      return (await SentinalPlugin({
        project: { id: "fixture", worktree: root },
        client: {
          app: {
            log: async (opts: { body: { message: string } }) => {
              logs.push(opts.body.message);
            },
          },
          session: { messages: async () => ({ data: [] }) },
        },
        $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        directory: root,
        worktree: root,
      } as never)) as never;
    } finally {
      spy.mockRestore();
    }
  }

  it("keys sidecar sessions by the CANONICAL root, never by the worktree path or ''", async () => {
    const { fake, createdProjectPaths } = makeRootsFake();
    await initAt(linkedRoot, fake, []);

    expect(createdProjectPaths.length).toBeGreaterThan(0);
    for (const p of createdProjectPaths) {
      expect(p).toBe(mainRoot);
      expect(p).not.toBe("");
    }
  }, 30_000);

  it("session.idle stop-guard stays WORKTREE-LOCAL (main-checkout plan is ignored)", async () => {
    onlyPlanIn(mainRoot); // plan exists ONLY in the main checkout
    const { fake } = makeRootsFake();
    const logs: string[] = [];
    const hooks = await initAt(linkedRoot, fake, logs);

    await hooks.event!({ event: { type: "session.idle" } } as never);

    expect(logs.some((m) => m.includes("IN_PROGRESS"))).toBe(false);
  }, 30_000);

  it("session.idle stop-guard fires on the LOCAL worktree's own plan", async () => {
    onlyPlanIn(linkedRoot);
    const { fake } = makeRootsFake();
    const logs: string[] = [];
    const hooks = await initAt(linkedRoot, fake, logs);

    await hooks.event!({ event: { type: "session.idle" } } as never);

    expect(logs.some((m) => m.includes("IN_PROGRESS"))).toBe(true);
  }, 30_000);

  // ── compaction.autocontinue: workspace for the disk filter, identity for the key ──

  async function runAutocontinue(
    hooks: Record<string, (...a: never[]) => Promise<unknown>>,
  ): Promise<{ continue: boolean; context: string[] }> {
    const output = { continue: true, context: [] as string[] };
    await hooks["compaction.autocontinue"]!(
      { sessionID: "s1" } as never,
      output as never,
    );
    return output;
  }

  it("compaction.autocontinue PAUSES on a RED cycle under the LOCAL worktree", async () => {
    const rf = makeRootsFake();
    rf.activeCycles = [
      { filePath: join(linkedRoot, "src", "foo.ts"), state: "RED_CONFIRMED" },
    ];
    const hooks = await initAt(linkedRoot, rf.fake, []);

    const out = await runAutocontinue(hooks);

    expect(out.continue).toBe(false);
    expect(out.context.join("\n")).toContain("RED");
  }, 30_000);

  it("compaction.autocontinue ignores a RED cycle in ANOTHER checkout and keys the spec lookup by IDENTITY", async () => {
    const rf = makeRootsFake();
    rf.activeCycles = [
      { filePath: join(mainRoot, "src", "foo.ts"), state: "RED_CONFIRMED" },
    ];
    const hooks = await initAt(linkedRoot, rf.fake, []);
    rf.currentSpecProjects.length = 0;

    const out = await runAutocontinue(hooks);

    expect(out.continue).toBe(true);
    expect(rf.currentSpecProjects).toEqual([mainRoot]);
  }, 30_000);

  // ── session notifications reach the MODEL, not the TUI log ─────────────────
  // client.app.log() writes to OpenCode's TUI log panel, not the LLM context,
  // so logging the digest would be a signal that reaches nobody. The
  // system-prompt transform is the channel that reaches the model.

  function notification(id: number, title: string, projectPath: string) {
    return {
      id,
      type: "warning",
      title,
      message: `${title} details`,
      source: "session-end",
      specId: null,
      sessionId: null,
      read: false,
      createdAt: Date.now() - id,
      projectPath,
    };
  }

  async function runSystemTransform(
    hooks: Record<string, (...a: never[]) => Promise<unknown>>,
  ): Promise<string[]> {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      {} as never,
      output as never,
    );
    return output.system;
  }

  it("surfaces unread notifications into the SYSTEM PROMPT, keyed by IDENTITY, marking each read per-id", async () => {
    const rf = makeRootsFake();
    rf.sessionNotifications = [
      notification(7, "Build broke", mainRoot),
      notification(9, "Sidecar outdated", mainRoot),
    ];
    const logs: string[] = [];
    const hooks = await initAt(linkedRoot, rf.fake, logs);
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    } as never);

    const system = (await runSystemTransform(hooks)).join("\n");

    expect(system).toContain("Build broke");
    expect(system).toContain("Sidecar outdated");
    expect(rf.notificationListCalls).toEqual([mainRoot]);
    expect([...rf.markedRead].sort()).toEqual([7, 9]);
    // Not merely logged to the TUI panel.
    expect(logs.join("\n")).not.toContain("Build broke");
  }, 30_000);

  it("keeps the digest for the rest of the session without re-reading or re-marking", async () => {
    const rf = makeRootsFake();
    rf.sessionNotifications = [notification(3, "Build broke", mainRoot)];
    const hooks = await initAt(linkedRoot, rf.fake, []);
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    } as never);

    await runSystemTransform(hooks);
    const second = (await runSystemTransform(hooks)).join("\n");

    expect(second).toContain("Build broke");
    expect(rf.notificationListCalls.length).toBe(1);
    expect(rf.markedRead).toEqual([3]);
  }, 30_000);

  it("an OLD sidecar without the route (404) is silent: no throw, no digest, nothing marked", async () => {
    const rf = makeRootsFake();
    rf.listNotificationsError = new Error("Not found");
    const hooks = await initAt(linkedRoot, rf.fake, []);
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    } as never);

    const system = (await runSystemTransform(hooks)).join("\n");

    expect(system).not.toContain("Sentinal notifications");
    expect(rf.markedRead).toEqual([]);
  }, 30_000);

  // ── TDD tracking carries the canonical IDENTITY through every hop ──────────

  const afterOut = (output: string, exit: number) => ({
    title: "bun test",
    output,
    metadata: { exit },
  });

  it("TDD tracking: a test-file write records the canonical project on setTddState", async () => {
    const rf = makeRootsFake();
    const hooks = await initAt(linkedRoot, rf.fake, []);
    const testFile = join(linkedRoot, "src", "foo.test.ts");

    await hooks["tool.execute.after"]!(
      {
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { filePath: testFile },
      } as never,
      { title: "", output: "", metadata: {} } as never,
    );

    const written = rf.setTddStates.find((s) => s.testFilePath === testFile);
    expect(written).toBeDefined();
    expect(written!.projectPath).toBe(mainRoot);
  }, 30_000);

  it("TDD tracking: failing and passing test runs forward the IDENTITY to tddTransition", async () => {
    const rf = makeRootsFake();
    const hooks = await initAt(linkedRoot, rf.fake, []);
    const after = hooks["tool.execute.after"]!;

    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "bun test" },
      } as never,
      afterOut("1 tests failed\nexpect(received).toBe(expected)", 1) as never,
    );
    await after(
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "bun test" },
      } as never,
      afterOut("All 12 tests passed", 0) as never,
    );

    expect(rf.tddTransitions).toEqual([
      ["confirm_red", undefined, mainRoot],
      ["confirm_green", undefined, mainRoot],
    ]);
  }, 30_000);

  it("TDD tracking: a sidecar failure is written to the plugin debug log, never thrown", async () => {
    const logDir = realpathSync(
      mkdtempSync(join(tmpdir(), "sentinal-plugin-log-")),
    );
    const logDirSpy = spyOn(fileLogModule, "getLogDir").mockReturnValue(logDir);
    try {
      const rf = makeRootsFake();
      rf.setTddStateError = new Error("sidecar exploded");
      const hooks = await initAt(linkedRoot, rf.fake, []);

      await hooks["tool.execute.after"]!(
        {
          tool: "write",
          sessionID: "s1",
          callID: "c1",
          args: { filePath: join(linkedRoot, "src", "bar.test.ts") },
        } as never,
        { title: "", output: "", metadata: {} } as never,
      );

      const logged = readLastLines(join(logDir, PLUGIN_LOG_FILE), 200).join(
        "\n",
      );
      expect(logged).toContain("tdd-track");
      expect(logged).toContain("sidecar exploded");
    } finally {
      logDirSpy.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  }, 30_000);
});
