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
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
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

    // The exit-1 run is ALSO captured as an `auto-capture-failure` error
    // observation (Task 14); this test is about the heuristic capture only.
    const heuristic = () =>
      calls.observations.filter(
        (o) =>
          (o.metadata as Record<string, unknown>)?.source === "auto-capture",
      );
    expect(await until(() => heuristic().length > 0)).toBe(true);
    expect(heuristic()[0]!.title).toBe("Build/lint issue resolved");
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

    // Bounded wait: the heuristic capture must never fire when exit says
    // failure. (Both runs ARE failure-captured as `auto-capture-failure`.)
    await new Promise((r) => setTimeout(r, 300));
    expect(
      calls.observations.filter(
        (o) =>
          (o.metadata as Record<string, unknown>)?.source === "auto-capture",
      ),
    ).toHaveLength(0);
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
    restoreCalls: unknown[][];
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
    /** Every payload passed to addObservation. */
    observations: Array<Record<string, unknown>>;
    /** When set, addObservation rejects (drives the offline-queue fallback). */
    addObservationError: Error | null;
  }

  function makeRootsFake(): RootsFake {
    const createdProjectPaths: string[] = [];
    const currentSpecProjects: string[] = [];
    const restoreCalls: unknown[][] = [];
    const rf = {
      setTddStates: [] as Array<Record<string, unknown>>,
      tddTransitions: [] as unknown[][],
      activeCycles: [] as Array<{ filePath: string; state: string }>,
      setTddStateError: null as Error | null,
      sessionNotifications: [] as Array<Record<string, unknown>>,
      notificationListCalls: [] as string[],
      markedRead: [] as number[],
      listNotificationsError: null as Error | null,
      observations: [] as Array<Record<string, unknown>>,
      addObservationError: null as Error | null,
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
      addObservation: async (obs: Record<string, unknown>) => {
        if (rf.addObservationError) throw rf.addObservationError;
        rf.observations.push(obs);
        return { id: rf.observations.length };
      },
      memorySearch: async () => [],
      getActiveSessions: async () => [],
      restoreContext: async (...args: unknown[]) => {
        restoreCalls.push(args);
        return { hasMemory: false, markdown: "" };
      },
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
      restoreCalls,
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
      get observations() {
        return rf.observations;
      },
      get addObservationError() {
        return rf.addObservationError;
      },
      set addObservationError(v) {
        rf.addObservationError = v;
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

  it("restores memory keyed by IDENTITY with shared memory from the LOCAL worktree (D8)", async () => {
    const rf = makeRootsFake();
    const hooks = await initAt(linkedRoot, rf.fake, []);
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    } as never);
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" } as never,
      { context: [] } as never,
    );

    expect(rf.restoreCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of rf.restoreCalls) {
      expect(call[0]).toBe(mainRoot);
      expect(call[2]).toBe(linkedRoot);
    }
  }, 30_000);

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

  // ── Failure capture (Task 14) ──────────────────────────────────────────────
  // Bash non-zero exits arrive on tool.execute.after; thrown tool failures
  // never do — they arrive ONLY as a `message.part.updated` event whose tool
  // part ends in `state.status === "error"` (Task 8 spike, OpenCode 1.18.32).
  describe("failure capture → error observations", () => {
    let pendingSpy: ReturnType<typeof spyOn>;
    let enqueueSpy: ReturnType<typeof spyOn>;
    const enqueued: Array<Record<string, unknown>> = [];

    beforeAll(() => {
      pendingSpy = spyOn(ObservationQueue, "pending").mockReturnValue(0);
      enqueueSpy = spyOn(ObservationQueue, "enqueue").mockImplementation(((
        obs: Record<string, unknown>,
      ) => {
        enqueued.push(obs);
      }) as never);
    });

    afterAll(() => {
      pendingSpy.mockRestore();
      enqueueSpy.mockRestore();
    });

    async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
      const start = Date.now();
      while (!cond() && Date.now() - start < ms) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return cond();
    }

    /** Let fire-and-forget work settle when asserting that NOTHING happened. */
    const settle = () => new Promise((r) => setTimeout(r, 150));

    const failures = (obs: Array<Record<string, unknown>>) =>
      obs.filter(
        (o) =>
          (o.metadata as Record<string, unknown> | undefined)?.source ===
          "auto-capture-failure",
      );

    const SECRET = "hunter2-SECRET-TOKEN-9f3a";

    async function runBash(
      hooks: Record<string, (...a: never[]) => Promise<unknown>>,
      command: string,
      output: string,
      exit: number | null,
      callID = "call_bash_1",
    ) {
      await hooks["tool.execute.after"]!(
        {
          tool: "bash",
          sessionID: "ses_fx",
          callID,
          args: { command },
        } as never,
        { title: command, output, metadata: { exit } } as never,
      );
    }

    // Shape captured verbatim by the Task 8 spike (ids shortened).
    function errorPart(
      over: {
        id?: string;
        callID?: string;
        tool?: string;
        status?: string;
        input?: Record<string, unknown>;
        error?: string;
        metadata?: Record<string, unknown>;
      } = {},
    ) {
      return {
        event: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_fx",
            part: {
              id: over.id ?? "prt_01JFX0000000000000000EDIT",
              sessionID: "ses_fx",
              messageID: "msg_01JFX00000000000000000000",
              type: "tool",
              callID: over.callID ?? "call_edit_1",
              tool: over.tool ?? "edit",
              state: {
                status: over.status ?? "error",
                input: over.input ?? {
                  filePath: join(linkedRoot, "src", "widget.ts"),
                  oldString: "const a = 1;",
                  newString: "const a = 2;",
                },
                error:
                  over.error ??
                  "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
                ...(over.metadata ? { metadata: over.metadata } : {}),
                time: { start: 1727180000000, end: 1727180000100 },
              },
            },
            time: 1727180000100,
          },
        },
      } as never;
    }

    function assertNoRawText(obs: Record<string, unknown>, raw: string) {
      const meta = JSON.stringify(obs.metadata ?? {});
      const tags = JSON.stringify(obs.tags ?? []);
      expect(meta).not.toContain(raw);
      expect(tags).not.toContain(raw);
    }

    // ── bash half ─────────────────────────────────────────────────────────

    it("a non-zero bash exit → one error observation, canonical project, signature metadata", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      const out = `error: Cannot find module 'left-pad' (auth ${SECRET})`;

      await runBash(hooks, "node scripts/build.mjs", out, 3);

      expect(await until(() => failures(rf.observations).length > 0)).toBe(
        true,
      );
      await settle();
      const got = failures(rf.observations);
      expect(got).toHaveLength(1);
      const o = got[0];
      expect(o.type).toBe("error");
      expect(o.projectPath).toBe(mainRoot);
      const meta = o.metadata as Record<string, unknown>;
      expect(meta.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(meta.toolName).toBe("bash");
      expect(meta.exitCode).toBe(3);
      expect(String(o.content)).toContain("Cannot find module");
      assertNoRawText(o, SECRET);
      assertNoRawText(o, "Cannot find module");
    }, 30_000);

    it("exit 0 → no failure observation", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await runBash(hooks, "node scripts/build.mjs", "error: looks bad", 0);
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("an aborted bash (exit null + abort marker) → no failure observation", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await runBash(
        hooks,
        "sleep 60",
        "partial\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
        null,
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("an abort marker suppresses capture even when an exit code is present", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await runBash(
        hooks,
        "node scripts/build.mjs",
        "error: boom\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
        130,
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("a sidecar failure falls back to the offline queue with the same payload", async () => {
      const rf = makeRootsFake();
      rf.addObservationError = new Error("sidecar down");
      const hooks = await initAt(linkedRoot, rf.fake, []);
      enqueued.length = 0;

      await runBash(hooks, "node scripts/build.mjs", "error: TS2304 boom", 2);

      expect(await until(() => failures(enqueued).length > 0)).toBe(true);
      const q = failures(enqueued)[0];
      expect(q.type).toBe("error");
      expect(q.projectPath).toBe(mainRoot);
      expect((q.metadata as Record<string, unknown>).exitCode).toBe(2);
    }, 30_000);

    // ── thrown-failure half (message.part.updated) ────────────────────────

    it("an error tool part → one error observation with signature metadata", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);

      await hooks.event!(errorPart());

      expect(await until(() => failures(rf.observations).length > 0)).toBe(
        true,
      );
      await settle();
      const got = failures(rf.observations);
      expect(got).toHaveLength(1);
      const o = got[0];
      expect(o.type).toBe("error");
      expect(o.projectPath).toBe(mainRoot);
      const meta = o.metadata as Record<string, unknown>;
      expect(meta.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(meta.toolName).toBe("edit");
      expect("exitCode" in meta).toBe(false);
      expect(String(o.content)).toContain("widget.ts");
      expect(String(o.content)).toContain("Could not find oldString");
      assertNoRawText(o, "Could not find oldString");
    }, 30_000);

    it("the same part.id delivered twice → one observation", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);

      await hooks.event!(errorPart());
      await hooks.event!(errorPart());

      await until(() => failures(rf.observations).length > 0);
      await settle();
      expect(failures(rf.observations)).toHaveLength(1);
    }, 30_000);

    it("a repeated callID on DIFFERENT parts is not deduped (callID is not unique)", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);

      await hooks.event!(errorPart({ id: "prt_A", callID: "call_dup" }));
      await hooks.event!(
        errorPart({
          id: "prt_B",
          callID: "call_dup",
          tool: "read",
          input: { filePath: join(linkedRoot, "missing.ts") },
          error: `File not found: ${join(linkedRoot, "missing.ts")}`,
        }),
      );

      expect(await until(() => failures(rf.observations).length >= 2)).toBe(
        true,
      );
    }, 30_000);

    it("a [Sentinal guard error part → none", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await hooks.event!(
        errorPart({
          id: "prt_guard",
          error:
            "[Sentinal TDD Guard] Write a failing test before editing src/widget.ts",
        }),
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("an interrupted part (metadata.interrupted) → none", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await hooks.event!(
        errorPart({
          id: "prt_int",
          tool: "bash",
          input: { command: "rm -rf build" },
          error: "Tool execution aborted",
          metadata: { interrupted: true },
        }),
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("the user's own permission decisions → none", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await hooks.event!(
        errorPart({
          id: "prt_rej",
          tool: "bash",
          input: { command: "git push" },
          error: "The user rejected permission to use this specific tool call.",
        }),
      );
      await hooks.event!(
        errorPart({
          id: "prt_rule",
          tool: "bash",
          input: { command: "rm -rf /" },
          error:
            'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"bash","pattern":"rm *","action":"deny"}]',
        }),
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("a completed tool part (e.g. a failed bash, which finishes `completed`) → none", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await hooks.event!(
        errorPart({
          id: "prt_done",
          tool: "bash",
          status: "completed",
          input: { command: "exit 3" },
          metadata: { exit: 3 },
        }),
      );
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);

    it("a malformed error event never throws into OpenCode", async () => {
      const rf = makeRootsFake();
      const hooks = await initAt(linkedRoot, rf.fake, []);
      await expect(
        hooks.event!({
          event: {
            type: "message.part.updated",
            properties: { part: { type: "tool", state: { status: "error" } } },
          },
        } as never),
      ).resolves.toBeUndefined();
      await settle();
      expect(failures(rf.observations)).toHaveLength(0);
    }, 30_000);
  });
});

// ─── SENTINAL_HOME seam (hardening-sweep Task 7) ──────────────────────────────
//
// The plugin used to resolve `~/.sentinal` ONCE at module load via homedir(),
// so the sidecar pid it checked, the binary it spawned and the config.json it
// read all ignored SENTINAL_HOME — while ensureDashboard honoured it. Every
// plugin test therefore read the REAL pid/config and could spawn the REAL
// binary. This drives init against a throwaway tree set AFTER module load
// (proving the paths are read fresh) and asserts nothing touched the real one.
describe("SentinalPlugin honours SENTINAL_HOME (read fresh)", () => {
  it("checks the pid, spawns the binary and reads config.json under SENTINAL_HOME only", async () => {
    const realHome = join(homedir(), ".sentinal");
    const realPid = join(realHome, "sidecar.pid");
    const realPidMtime = existsSync(realPid) ? statSync(realPid).mtimeMs : null;

    const home = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-home-t7-")));
    const record = join(home, "invocations.log");
    mkdirSync(join(home, "bin"), { recursive: true });
    const stub = join(home, "bin", "sentinal");
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${record}"\n`);
    chmodSync(stub, 0o755);
    // A PID that cannot be alive (above any pid_max) → stale.
    writeFileSync(join(home, "sidecar.pid"), "2147483646");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ memory: { enabled: false } }),
    );

    const prev = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = home;
    try {
      const hooks = await SentinalPlugin({
        project: { id: "t7", worktree: home },
        client: {
          app: { log: async () => {} },
          session: { messages: async () => ({ data: [] }) },
        },
        $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        directory: home,
        worktree: home,
      } as never);
      expect(hooks).toBeDefined();

      // The stub records its own invocation (spawned detached → poll).
      const deadline = Date.now() + 5_000;
      let calls = "";
      while (Date.now() < deadline) {
        calls = existsSync(record) ? readFileSync(record, "utf-8") : "";
        if (calls.includes("sidecar start")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(calls).toContain("sidecar start");

      const pluginLog = readFileSync(join(home, PLUGIN_LOG_FILE), "utf-8");
      expect(pluginLog).toContain("respawn: sidecar start (pid file stale)");
      // config.json was read from the temp tree, not ~/.sentinal.
      expect(pluginLog).toContain("Memory system disabled via config");
    } finally {
      if (prev === undefined) delete process.env.SENTINAL_HOME;
      else process.env.SENTINAL_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }

    // The real tree was never touched.
    if (realPidMtime !== null) {
      expect(statSync(realPid).mtimeMs).toBe(realPidMtime);
    }
  }, 30_000);
});

// ─── D9: error → fix capture on the plugin (hardening-sweep Task 11) ──────────
//
// The plugin keeps ONE in-memory EventBuffer per plugin instance, pushed before
// analysis. A bash call's exit arrives as `metadata.exit` and must override
// the text: " 0 fail" in a passing bun run is not an error. Runs under a temp
// SENTINAL_HOME so nothing reaches the real ~/.sentinal.
describe("memory capture: error → fix (D9)", () => {
  let home: string;
  let prevHome: string | undefined;
  let queuePendingSpy: ReturnType<typeof spyOn>;
  let queueEnqueueSpy: ReturnType<typeof spyOn>;

  const BUN_PASS =
    "bun test v1.3.10 (30e609e0)\n\n 12 pass\n 0 fail\n 30 expect() calls\nRan 12 tests across 3 files. [120.00ms]\n";
  const BUN_FAIL =
    "bun test v1.3.10 (30e609e0)\n\nmath.test.ts:\nerror: expect(received).toBe(expected)\n\n(fail) adds [3.15ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [18.00ms]\n";

  beforeAll(() => {
    prevHome = process.env.SENTINAL_HOME;
    home = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-home-t11-")));
    mkdirSync(join(home, "bin"), { recursive: true });
    const stub = join(home, "bin", "sentinal");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    process.env.SENTINAL_HOME = home;
    queuePendingSpy = spyOn(ObservationQueue, "pending").mockReturnValue(0);
    queueEnqueueSpy = spyOn(ObservationQueue, "enqueue").mockImplementation(
      () => {},
    );
  });

  afterAll(() => {
    queuePendingSpy.mockRestore();
    queueEnqueueSpy.mockRestore();
    if (prevHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function setup() {
    const observations: Array<Record<string, unknown>> = [];
    const fake = {
      createSession: async () => {},
      endSession: async () => {},
      getTddState: async () => ({ state: "IDLE", hasActiveSpec: false }),
      setTddState: async () => {},
      tddTransition: async () => ({ count: 0 }),
      addObservation: async (obs: Record<string, unknown>) => {
        observations.push(obs);
      },
      memorySearch: async () => [],
    } as unknown as SidecarClient;
    const spy = spyOn(SidecarClient, "connectWithRetry").mockResolvedValue(
      fake,
    );
    let hooks: Awaited<ReturnType<typeof SentinalPlugin>>;
    try {
      hooks = await SentinalPlugin({
        project: { name: "t11", path: home },
        client: {
          app: { log: async () => {} },
          session: { messages: async () => ({ data: [] }) },
        },
        $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        directory: home,
        worktree: home,
      } as never);
    } finally {
      spy.mockRestore();
    }
    const after = hooks["tool.execute.after"]!;
    let n = 0;
    // The capture phase is fire-and-forget: settle between calls so events
    // reach the buffer in call order.
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const bash = async (output: string, exit: number) => {
      await after(
        {
          tool: "bash",
          sessionID: "s1",
          callID: `c${++n}`,
          args: { command: "bun test" },
        } as never,
        { title: "bun test", output, metadata: { exit } } as never,
      );
      await settle();
    };
    const edit = async (file: string) => {
      await after(
        {
          tool: "edit",
          sessionID: "s1",
          callID: `c${++n}`,
          args: { filePath: join(home, file) },
        } as never,
        { title: file, output: "", metadata: {} } as never,
      );
      await settle();
    };
    const fixes = () =>
      observations.filter((o) => String(o.title).startsWith("Fixed issue"));
    return { bash, edit, fixes };
  }

  it("a passing bun run (exit 0, ' 0 fail') + edits → no fix", async () => {
    const { bash, edit, fixes } = await setup();
    await bash(BUN_PASS, 0);
    for (const f of ["a.md", "b.ts", "c.ts", "d.ts"]) await edit(f);
    expect(fixes()).toHaveLength(0);
  }, 30_000);

  it("exit 0 with error text is not an error", async () => {
    const { bash, edit, fixes } = await setup();
    await bash("src/a.ts(1,7): error TS2322: Type 'string'", 0);
    await edit("a.ts");
    expect(fixes()).toHaveLength(0);
  }, 30_000);

  it("one real failure + 4 edits → exactly one fix", async () => {
    const { bash, edit, fixes } = await setup();
    await bash(BUN_FAIL, 1);
    for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) await edit(f);
    expect(fixes()).toHaveLength(1);
    expect(fixes()[0]!.title).toBe("Fixed issue in a.ts");
  }, 30_000);

  it("a .md edit after a failure is not a fix; the next code edit is", async () => {
    const { bash, edit, fixes } = await setup();
    await bash(BUN_FAIL, 1);
    await edit("NOTES.md");
    expect(fixes()).toHaveLength(0);
    await edit("src/x.ts");
    expect(fixes()).toHaveLength(1);
  }, 30_000);
});
