/**
 * Memory Observer Hook Tests
 *
 * Tests the hook's core logic: event buffer persistence,
 * tool event construction, and capture-to-storage pipeline.
 *
 * Since the hook runs as a standalone process reading stdin,
 * we test the key functions it uses rather than spawning processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import {
  analyzeEvent,
  EventBuffer,
  MIN_CAPTURE_CONFIDENCE,
  type ToolEvent,
} from "../memory/capture.js";
import { processMemoryObserver } from "./memory-observer.js";
import { SidecarClient } from "../sidecar/client.js";
import { resolveRealPath } from "../worktree/disk-scan.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDb(): string {
  const dir = makeTmpDir();
  return join(dir, "test.db");
}

// ─── Event Buffer Persistence ────────────────────────────────────────────────

describe("event buffer persistence", () => {
  let tmpDir: string;
  let bufferPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const sentinalDir = join(tmpDir, ".sentinal");
    mkdirSync(sentinalDir, { recursive: true });
    bufferPath = join(sentinalDir, "event-buffer.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should serialize event buffer to JSON", () => {
    const buffer = new EventBuffer(20);
    buffer.push({
      toolName: "Edit",
      filePath: "src/foo.ts",
      success: true,
      timestamp: 1000,
    });
    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error TS2345",
      timestamp: 2000,
    });

    // Simulate the save logic from the hook
    const events = buffer.recent(20).reverse();
    writeFileSync(bufferPath, JSON.stringify(events));

    const loaded = JSON.parse(readFileSync(bufferPath, "utf-8"));
    expect(loaded).toHaveLength(2);
    expect(loaded[0].toolName).toBe("Edit");
    expect(loaded[1].toolName).toBe("Bash");
  });

  it("should deserialize event buffer from JSON", () => {
    const events: ToolEvent[] = [
      {
        toolName: "Write",
        filePath: "src/new.ts",
        success: true,
        timestamp: 1000,
      },
      { toolName: "Bash", success: false, output: "FAILED", timestamp: 2000 },
    ];
    writeFileSync(bufferPath, JSON.stringify(events));

    // Simulate the load logic from the hook
    const buffer = new EventBuffer(20);
    const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
    for (const event of data) {
      buffer.push(event as ToolEvent);
    }

    expect(buffer.size).toBe(2);
    const recent = buffer.recent(2);
    expect(recent[0].timestamp).toBe(2000);
    expect(recent[1].timestamp).toBe(1000);
  });

  it("should handle corrupted buffer file gracefully", () => {
    writeFileSync(bufferPath, "not valid json{{{");

    const buffer = new EventBuffer(20);
    try {
      const data = JSON.parse(readFileSync(bufferPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const event of data) buffer.push(event);
      }
    } catch {
      // Expected: corrupted file, start fresh
    }

    expect(buffer.size).toBe(0);
  });

  it("should handle missing buffer file gracefully", () => {
    const buffer = new EventBuffer(20);
    const missingPath = join(tmpDir, ".sentinal", "nonexistent.json");

    if (existsSync(missingPath)) {
      const data = JSON.parse(readFileSync(missingPath, "utf-8"));
      for (const event of data as ToolEvent[]) buffer.push(event);
    }

    expect(buffer.size).toBe(0);
  });
});

// ─── Tool Event Construction ─────────────────────────────────────────────────

describe("tool event construction from hook input", () => {
  it("should extract filePath from file_path field", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    };
    const filePath = (input.tool_input.file_path as string) ?? undefined;

    expect(filePath).toBe("src/auth.ts");
  });

  it("should construct a valid ToolEvent", () => {
    const event: ToolEvent = {
      toolName: "Write",
      filePath: "src/new-file.ts",
      success: true,
      output: undefined,
      timestamp: Date.now(),
    };

    expect(event.toolName).toBe("Write");
    expect(event.filePath).toBe("src/new-file.ts");
    expect(event.success).toBe(true);
  });
});

// ─── Real Claude Code Bash payloads reach the buffer ─────────────────────────
//
// Drives the REAL processMemoryObserver and reads back the event it persisted.
// Claude Code's Bash tool_response is {stdout, stderr, interrupted, isImage,
// noOutputExpected} — there is no `output` field (verified in real transcripts).

describe("processMemoryObserver reads Claude Code Bash output", () => {
  let tmpDir: string;
  let origConnect: typeof SidecarClient.connect;

  beforeEach(() => {
    tmpDir = makeTmpDir("sentinal-obs-bash");
    origConnect = SidecarClient.connect;
    // Keep the hook off any real sidecar; nothing here should capture anyway.
    SidecarClient.connect = (async () => ({
      addObservation: async () => ({ id: 1 }),
    })) as unknown as typeof SidecarClient.connect;
  });

  afterEach(() => {
    SidecarClient.connect = origConnect;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function lastBufferedOutput(
    toolResponse: Record<string, unknown>,
  ): Promise<string | undefined> {
    await processMemoryObserver({
      session_id: "bash-session",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: toolResponse,
    });
    const events = JSON.parse(
      readFileSync(join(tmpDir, ".sentinal", "event-buffer.json"), "utf-8"),
    ) as ToolEvent[];
    return events[events.length - 1].output;
  }

  it("captures stdout and stderr from the documented shape", async () => {
    const output = await lastBufferedOutput({
      stdout: "src/foo.test.ts:\n 0 pass\n 1 fail\n",
      stderr: "error: expect(received).toBe(expected)",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    expect(output).toContain(" 1 fail");
    expect(output).toContain("expect(received).toBe(expected)");
    expect(output).not.toBe("bun test");
  });

  it("still reads the legacy {output} shape", async () => {
    const output = await lastBufferedOutput({ output: "legacy hello" });
    expect(output).toBe("legacy hello");
  });
});

// ─── D9: error → fix through the real hook (hardening-sweep Task 11) ─────────
//
// The CC buffer is a per-checkout FILE (<cwd>/.sentinal/event-buffer.json),
// re-read and re-written on every invocation, so "consumed" must travel inside
// the persisted events. Bash reaching this hook came through PostToolUse,
// which fires ONLY on success (exit 0); failures arrive via
// tool-failure-observer as `success: false` events in the same file.
describe("processMemoryObserver error → fix capture (D9)", () => {
  let tmpDir: string;
  let origConnect: typeof SidecarClient.connect;
  let sent: Array<{ title: string; metadata: Record<string, unknown> }>;

  beforeEach(() => {
    tmpDir = makeTmpDir("sentinal-obs-d9");
    mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    sent = [];
    origConnect = SidecarClient.connect;
    SidecarClient.connect = (async () => ({
      addObservation: async (obs: {
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        sent.push(obs);
        return { id: sent.length };
      },
    })) as unknown as typeof SidecarClient.connect;
  });

  afterEach(() => {
    SidecarClient.connect = origConnect;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const bufferFile = () => join(tmpDir, ".sentinal", "event-buffer.json");
  const fixes = () => sent.filter((o) => o.title.startsWith("Fixed issue"));

  function primeFailure(): void {
    // Exactly what tool-failure-observer writes for a failed Bash call.
    writeFileSync(
      bufferFile(),
      JSON.stringify([
        {
          toolName: "Bash",
          success: false,
          output:
            "Exit code 1\nsrc/foo.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
          timestamp: Date.now() - 5000,
        },
      ]),
    );
  }

  const run = (
    tool_name: string,
    tool_input: Record<string, unknown>,
    tool_response?: Record<string, unknown>,
  ) =>
    processMemoryObserver({
      session_id: "d9",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name,
      tool_input,
      ...(tool_response && { tool_response }),
    });

  it("one real failure + 4 edits → exactly one fix (consumed across invocations)", async () => {
    primeFailure();
    for (const f of ["a", "b", "c", "d"])
      await run("Edit", { file_path: `src/${f}.ts` });
    expect(fixes()).toHaveLength(1);
    expect(fixes()[0].title).toBe("Fixed issue in a.ts");
  });

  it("a successful Bash whose text looks like an error is buffered with exit 0 and never fixed", async () => {
    await run(
      "Bash",
      { command: "bun test" },
      {
        stdout:
          "bun test v1.3.10\n\n 12 pass\n 0 fail\nerror TS2322 mentioned in a fixture\n",
        stderr: "",
      },
    );
    const events = JSON.parse(
      readFileSync(bufferFile(), "utf-8"),
    ) as ToolEvent[];
    expect(events[events.length - 1].exitCode).toBe(0);
    for (const f of ["a", "b"]) await run("Edit", { file_path: `src/${f}.ts` });
    expect(fixes()).toHaveLength(0);
  });

  it("a .md / docs/ edit after a failure is not a fix, the next code edit is", async () => {
    primeFailure();
    await run("Write", { file_path: "notes/CHANGES.md" });
    await run("Edit", { file_path: "docs/guide.txt" });
    expect(fixes()).toHaveLength(0);
    await run("Edit", { file_path: "src/real.ts" });
    expect(fixes()).toHaveLength(1);
  });
});

// ─── Direct fallback uses the deduped path (hardening-sweep Task 15, D10) ────

describe("processMemoryObserver direct fallback dedupes (D10)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = makeTmpDir("sentinal-obs-d10");
    mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    store = new MemoryStore(join(tmpDir, "direct.db"));
    service = new MemoryService(store);
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("10 identical fixes with no sidecar → 1 row with occurrences 10", async () => {
    let closes = 0;
    const deps = {
      connect: async () => null,
      // The hook closes the service it opened; keep the test's store open.
      openService: () => ({
        addObservationDeduped: (
          o: Parameters<MemoryService["addObservationDeduped"]>[0],
        ) => service.addObservationDeduped(o),
        close: () => {
          closes++;
        },
      }),
    };
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(tmpDir, ".sentinal", "event-buffer.json"),
        JSON.stringify([
          {
            toolName: "Bash",
            success: false,
            output:
              "Exit code 1\nsrc/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
            timestamp: Date.now() - 5000,
          },
        ]),
      );
      await processMemoryObserver(
        {
          session_id: "d10",
          transcript_path: "",
          cwd: tmpDir,
          permission_mode: "default",
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "src/a.ts" },
        },
        deps,
      );
    }
    expect(closes).toBe(10);
    expect(store.getStats().totalObservations).toBe(1);
    const { id } = (store as any).db
      .prepare("SELECT id FROM observations")
      .get() as { id: number };
    const row = store.getObservation(id);
    expect(row!.title).toBe("Fixed issue in a.ts");
    expect(row!.metadata.occurrences).toBe(10);
    expect(row!.metadata.source).toBe("auto-capture");
  });
});

// ─── Capture-to-Storage Pipeline ─────────────────────────────────────────────

describe("capture-to-storage pipeline", () => {
  let dbPath: string;
  let store: MemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    dbPath = makeTmpDb();
    store = new MemoryStore(dbPath);
    service = new MemoryService(store);
  });

  afterEach(() => {
    service.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it("should capture and store an error-fix sequence", () => {
    const buffer = new EventBuffer(20);

    // Simulate error event
    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error TS2345: Argument of type 'string'",
      filePath: "src/auth.ts",
      timestamp: Date.now() - 5000,
    });

    // Simulate fix event
    const fixEvent: ToolEvent = {
      toolName: "Edit",
      success: true,
      filePath: "src/auth.ts",
      timestamp: Date.now(),
    };
    buffer.push(fixEvent);

    const decision = analyzeEvent(fixEvent, buffer);

    expect(decision.shouldCapture).toBe(true);
    expect(decision.confidence).toBeGreaterThanOrEqual(MIN_CAPTURE_CONFIDENCE);

    // Store the observation (mimics hook behavior)
    const obs = service.addObservation({
      sessionId: "test-session",
      projectPath: "/test/project",
      timestamp: Date.now(),
      type: decision.type,
      title: decision.title,
      content: decision.content,
      filePaths: decision.filePaths,
      tags: decision.tags,
      metadata: { source: "auto-capture", confidence: decision.confidence },
    });

    expect(obs.id).toBeGreaterThan(0);
    expect(obs.type).toBe("fix");

    // Verify it's retrievable
    const retrieved = service.getObservation(obs.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toContain("fix");
  });

  it("should not store when capture decision is negative", () => {
    const buffer = new EventBuffer(20);

    const event: ToolEvent = {
      toolName: "Read",
      success: true,
      filePath: "src/readme.md",
      timestamp: Date.now(),
    };
    buffer.push(event);

    const decision = analyzeEvent(event, buffer);
    expect(decision.shouldCapture).toBe(false);

    // Pipeline would not store anything
    const stats = service.getStats();
    expect(stats.totalObservations).toBe(0);
  });

  // Historically this test called the real observer with no stub and asserted
  // nothing — it was the source of the rows leaked into the user's live DB.
  // Now `connect` is stubbed to capture the payload, so it never reaches any
  // sidecar or store, and it asserts what it names.
  it("should include agent_id and duration_ms in observation metadata", async () => {
    const tmpDir = makeTmpDir();
    const sentinalDir = join(tmpDir, ".sentinal");
    mkdirSync(sentinalDir, { recursive: true });

    const sent: Array<{ type: string; metadata: Record<string, unknown> }> = [];
    const origConnect = SidecarClient.connect;
    SidecarClient.connect = (async () => ({
      addObservation: async (obs: {
        type: string;
        metadata: Record<string, unknown>;
      }) => {
        sent.push(obs);
        return { id: 1 };
      },
    })) as unknown as typeof SidecarClient.connect;

    // Prime the buffer with an error so the next Edit triggers capture
    const bufferPath = join(sentinalDir, "event-buffer.json");
    const primeEvents: ToolEvent[] = [
      {
        toolName: "Bash",
        success: false,
        output: "error TS1234: Type mismatch",
        filePath: "src/foo.ts",
        timestamp: Date.now() - 5000,
      },
    ];
    writeFileSync(bufferPath, JSON.stringify(primeEvents));

    const input = {
      session_id: "agent-test-session",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "auto",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts" },
      agent_id: "agent-abc-123",
      agent_type: "Explore",
      duration_ms: 350,
      last_assistant_message:
        "I fixed the type error in foo.ts by adjusting the parameter type.",
    };

    try {
      await processMemoryObserver(input as any);
    } finally {
      SidecarClient.connect = origConnect;
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // The primed error + this Edit form an error → fix sequence.
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("fix");
    expect(sent[0].metadata).toMatchObject({
      source: "auto-capture",
      agent_id: "agent-abc-123",
      agent_type: "Explore",
      duration_ms: 350,
    });
    expect(sent[0].metadata.last_assistant_message).toBe(
      input.last_assistant_message.slice(0, 200),
    );
  });

  it("should sanitize content when storing", () => {
    const buffer = new EventBuffer(20);

    buffer.push({
      toolName: "Bash",
      success: false,
      output: "error: password=mysecretpass123 not found",
      filePath: "src/config.ts",
      timestamp: Date.now() - 5000,
    });

    const fixEvent: ToolEvent = {
      toolName: "Edit",
      success: true,
      filePath: "src/config.ts",
      timestamp: Date.now(),
    };
    buffer.push(fixEvent);

    const decision = analyzeEvent(fixEvent, buffer);

    if (decision.shouldCapture) {
      const obs = service.addObservation({
        sessionId: "test-session",
        projectPath: "/test",
        timestamp: Date.now(),
        type: decision.type,
        title: decision.title,
        content: decision.content,
        filePaths: decision.filePaths,
        tags: decision.tags,
        metadata: {},
      });

      // Content should be sanitized (password redacted)
      const retrieved = service.getObservation(obs.id);
      expect(retrieved!.content).not.toContain("mysecretpass123");
    }
  });
});

// ─── Project Identity Keying ─────────────────────────────────────────────────

/**
 * The hook's `projectPath` is a STORAGE KEY. It must be the canonical main
 * checkout so that an observation recorded from a linked worktree is visible
 * from the main checkout (and vice versa) — see src/project/identity.ts.
 */
describe("observation projectPath keying", () => {
  const tmpDirs: string[] = [];
  let origConnect: typeof SidecarClient.connect;

  function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${r.stderr?.toString() ?? ""}`,
      );
    }
  }

  /** Real repo + real linked worktree. The assertion depends on both. */
  function makeRepoWithWorktree(): { mainDir: string; worktreeDir: string } {
    const parent = makeTmpDir("sentinal-obs-identity");
    tmpDirs.push(parent);
    const mainDir = join(parent, "main");
    mkdirSync(mainDir, { recursive: true });

    git(["init", "-b", "main"], mainDir);
    git(["config", "user.email", "test@example.com"], mainDir);
    git(["config", "user.name", "Test"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "# test\n");
    git(["add", "."], mainDir);
    git(["commit", "-m", "init"], mainDir);

    const worktreeDir = join(parent, "wt");
    git(["worktree", "add", "-b", "feature", worktreeDir], mainDir);

    return { mainDir, worktreeDir };
  }

  /** Prime the buffer with an error so the next Edit triggers a capture. */
  function primeBuffer(cwd: string): void {
    const sentinalDir = join(cwd, ".sentinal");
    mkdirSync(sentinalDir, { recursive: true });
    const primeEvents: ToolEvent[] = [
      {
        toolName: "Bash",
        success: false,
        output: "error TS1234: Type mismatch",
        filePath: "src/foo.ts",
        timestamp: Date.now() - 5000,
      },
    ];
    writeFileSync(
      join(sentinalDir, "event-buffer.json"),
      JSON.stringify(primeEvents),
    );
  }

  /**
   * Run the hook with a stubbed sidecar and return the payload it sent.
   * Stubbing `connect` also keeps the test off any real running sidecar.
   */
  async function captureObservation(
    cwd: string,
  ): Promise<Record<string, unknown>> {
    primeBuffer(cwd);
    const sent: Record<string, unknown>[] = [];
    SidecarClient.connect = (async () => ({
      addObservation: async (obs: Record<string, unknown>) => {
        sent.push(obs);
        return { id: 1 };
      },
    })) as unknown as typeof SidecarClient.connect;

    await processMemoryObserver({
      session_id: "identity-session",
      transcript_path: "",
      cwd,
      permission_mode: "auto",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts" },
    } as never);

    expect(sent).toHaveLength(1);
    return sent[0];
  }

  beforeEach(() => {
    origConnect = SidecarClient.connect;
  });

  afterEach(() => {
    SidecarClient.connect = origConnect;
    for (const dir of tmpDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("keys an observation made inside a linked worktree to the main checkout", async () => {
    const { mainDir, worktreeDir } = makeRepoWithWorktree();

    const obs = await captureObservation(worktreeDir);

    expect(obs.projectPath).toBe(resolveRealPath(mainDir));
    expect(obs.projectPath).not.toBe(worktreeDir);
  }, 30_000);

  it("still produces a non-empty projectPath outside a git repository", async () => {
    const dir = makeTmpDir("sentinal-obs-nongit");
    tmpDirs.push(dir);

    const obs = await captureObservation(dir);

    expect(obs.projectPath).toBeTruthy();
    expect(obs.projectPath).toBe(resolveRealPath(dir));
  }, 30_000);
});
