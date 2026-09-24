/**
 * tool-failure-observer — Claude Code `PostToolUseFailure` capture (Task 11).
 *
 * Payloads follow the documented shape: common fields + tool_name, tool_input,
 * tool_use_id, error ("Exit code N\n…" for Bash), is_interrupt?, duration_ms?.
 * Every test injects its sink(s) — nothing here reaches the user's sidecar or
 * real ~/.sentinal (the preload also redirects SENTINAL_HOME).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import type { ToolEvent } from "../memory/capture.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { startSidecar, stopSidecar } from "../sidecar/server.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";
import type { ToolFailureSkipReason } from "../memory/tool-failure.js";
import {
  processToolFailure,
  buildToolFailureInput,
  type ToolFailureDeps,
} from "./tool-failure-observer.js";
import { processMemoryObserver } from "./memory-observer.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const INFRA_ERROR =
  "Exit code 1\nerror: Cannot find module 'express' from '/proj/src/server.ts'\n\nBun v1.3.10 (macOS arm64)";

function failure(cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "sess-failure",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "bun run src/server.ts", description: "Run" },
    tool_use_id: "toolu_01ABC",
    error: INFRA_ERROR,
    is_interrupt: false,
    duration_ms: 4187,
    ...extra,
  };
}

function errorRows(store: MemoryStore, project: string) {
  return store
    .getRecentForProject(project, 50)
    .filter((o) => o.type === "error");
}

// ─── Payload mapping ─────────────────────────────────────────────────────────

describe("buildToolFailureInput", () => {
  it("maps command, error and is_interrupt from a Bash payload", () => {
    const i = buildToolFailureInput(failure("/tmp/x", { is_interrupt: true }));
    expect(i).toEqual({
      toolName: "Bash",
      command: "bun run src/server.ts",
      filePath: undefined,
      error: INFRA_ERROR,
      interrupted: true,
    });
  });

  it("maps file_path (Edit) and path (Grep) to filePath", () => {
    expect(
      buildToolFailureInput(
        failure("/tmp/x", {
          tool_name: "Edit",
          tool_input: { file_path: "/p/a.ts", old_string: "x" },
          error: "String to replace not found in file.",
        }),
      )?.filePath,
    ).toBe("/p/a.ts");
    expect(
      buildToolFailureInput(
        failure("/tmp/x", {
          tool_name: "Grep",
          tool_input: { path: "/p/src" },
        }),
      )?.filePath,
    ).toBe("/p/src");
  });

  it("returns null when there is no error string or no tool name", () => {
    expect(
      buildToolFailureInput(failure("/tmp/x", { error: undefined })),
    ).toBeNull();
    expect(
      buildToolFailureInput(failure("/tmp/x", { tool_name: undefined })),
    ).toBeNull();
  });
});

// ─── Direct (no sidecar) path ────────────────────────────────────────────────

describe("processToolFailure — direct fallback", () => {
  let tmpDir: string;
  let dbPath: string;
  let project: string;
  let deps: ToolFailureDeps;

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir("sentinal-tfo"));
    dbPath = join(tmpDir, "db", "memory.db");
    mkdirSync(join(tmpDir, "db"), { recursive: true });
    project = resolveProjectIdentity(tmpDir);
    deps = {
      connect: async () => null,
      openService: () => new MemoryService(new MemoryStore(dbPath)),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores one error observation with safe metadata", async () => {
    const outcome = await processToolFailure(failure(tmpDir), deps);
    expect(outcome).toMatchObject({ captured: true, via: "direct" });

    const store = new MemoryStore(dbPath);
    const rows = errorRows(store, project);
    store.close();
    expect(rows).toHaveLength(1);
    const obs = rows[0];
    expect(obs.projectPath).toBe(project);
    expect(obs.sessionId).toBe("sess-failure");
    expect(obs.content).toContain("Cannot find module 'express'");
    expect(obs.title).toContain("failed");
    expect(obs.tags).toContain("tool-failure");
    expect(obs.metadata).toMatchObject({
      source: "auto-capture-failure",
      signature: outcome.signature,
      toolName: "Bash",
      exitCode: 1,
      duration_ms: 4187,
      tool_use_id: "toolu_01ABC",
      occurrences: 1,
    });
    expect(typeof obs.metadata.signature).toBe("string");
    expect(JSON.stringify(obs.metadata)).not.toContain("Cannot find module");
  });

  it("10 identical failures → 1 row with occurrences: 10 (addObservationDeduped)", async () => {
    for (let i = 0; i < 10; i++) {
      await processToolFailure(
        failure(tmpDir, { tool_use_id: `toolu_${i}` }),
        deps,
      );
    }
    const store = new MemoryStore(dbPath);
    const rows = errorRows(store, project);
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.occurrences).toBe(10);
  });

  it("different root errors produce separate rows", async () => {
    await processToolFailure(failure(tmpDir), deps);
    await processToolFailure(
      failure(tmpDir, {
        error: "Exit code 2\nSyntaxError: Unexpected token '}' at src/a.ts:3:1",
      }),
      deps,
    );
    const store = new MemoryStore(dbPath);
    expect(errorRows(store, project)).toHaveLength(2);
    store.close();
  });

  const EXCLUDED: Array<[ToolFailureSkipReason, Partial<HookInput>]> = [
    ["interrupted", { is_interrupt: true }],
    [
      "sentinal-guard",
      { error: "[Sentinal TDD Guard] Write a failing test first." },
    ],
    [
      "no-match-exit",
      { tool_input: { command: "grep -r needle src" }, error: "Exit code 1" },
    ],
    [
      "empty-output",
      { tool_input: { command: "false" }, error: "Exit code 1\n" },
    ],
    [
      "assertion-only-test-failure",
      {
        tool_input: { command: "bun test src/widget.test.ts" },
        error:
          "Exit code 1\nsrc/widget.test.ts:\n(fail) widget > renders [0.4ms]\nerror: expect(received).toBe(expected)\n\n 0 pass\n 1 fail\n 1 expect() calls\n",
      },
    ],
  ];

  for (const [reason, extra] of EXCLUDED) {
    it(`excluded class '${reason}' stores nothing`, async () => {
      const outcome = await processToolFailure(failure(tmpDir, extra), deps);
      expect(outcome.captured).toBe(false);
      expect(outcome.skipReason).toBe(reason);
      const store = new MemoryStore(dbPath);
      expect(store.getRecentForProject(project, 50)).toHaveLength(0);
      store.close();
    });
  }

  it("a payload without an error string stores nothing", async () => {
    const outcome = await processToolFailure(
      failure(tmpDir, { error: undefined }),
      deps,
    );
    expect(outcome).toMatchObject({ captured: false, skipReason: "no-error" });
  });

  it("never throws when both the sidecar and the direct store fail", async () => {
    const outcome = await processToolFailure(failure(tmpDir), {
      connect: async () => {
        throw new Error("socket boom");
      },
      openService: () => {
        throw new Error("db boom");
      },
    });
    expect(outcome.captured).toBe(false);
  });
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

describe("processToolFailure — secrets never land raw", () => {
  let tmpDir: string;
  let dbPath: string;
  let project: string;
  const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
  const PG_PASS = "hunter2SuperSecretPw";

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir("sentinal-tfo-secret"));
    dbPath = join(tmpDir, "memory.db");
    project = resolveProjectIdentity(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function capture(error: string, command = "bun run deploy.ts") {
    await processToolFailure(
      failure(tmpDir, { error, tool_input: { command } }),
      {
        connect: async () => null,
        openService: () => new MemoryService(new MemoryStore(dbPath)),
      },
    );
    const store = new MemoryStore(dbPath);
    const rows = errorRows(store, project);
    store.close();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("redacts secrets in title/content and keeps them out of metadata/tags", async () => {
    const obs = await capture(
      `Exit code 1\nerror: auth failed for token ${GH}\nconnecting to postgres://admin:${PG_PASS}@db.internal/app`,
      `GITHUB_TOKEN=${GH} bun run deploy.ts`,
    );
    for (const secret of [GH, PG_PASS]) {
      expect(obs.title).not.toContain(secret);
      expect(obs.content).not.toContain(secret);
      expect(JSON.stringify(obs.metadata)).not.toContain(secret);
      expect(JSON.stringify(obs.tags)).not.toContain(secret);
    }
    // No error text at all in metadata/tags.
    expect(JSON.stringify(obs.metadata)).not.toContain("auth failed");
    expect(JSON.stringify(obs.tags)).not.toContain("auth failed");
    expect(obs.content).toContain("REDACTED");
  });

  it("a secret cut by title truncation still leaves no fragment", async () => {
    // First error line ~95 chars of filler, then the token: the classifier's
    // 120-char title cuts the token below the redactor's 36-char minimum.
    const filler = "x".repeat(80);
    const obs = await capture(`Exit code 1\nerror: ${filler} ${GH}`);
    expect(obs.title).not.toContain(GH.slice(0, 12));
    expect(obs.content).not.toContain(GH.slice(0, 12));
  });
});

// ─── Sidecar path (real test sidecar, real /observation route) ──────────────

describe("processToolFailure — sidecar route dedupe", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let client: SidecarClient;
  let project: string;

  beforeEach(async () => {
    tmpDir = realpathSync(makeTmpDir("sentinal-tfo-sidecar"));
    store = new MemoryStore(join(tmpDir, "sidecar.db"));
    sidecar = await startSidecar({
      store,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });
    const port = (sidecar.server as unknown as { port: number }).port;
    client = (
      SidecarClient as unknown as { buildForTest(u: string): SidecarClient }
    ).buildForTest(`http://127.0.0.1:${port}`);
    project = resolveProjectIdentity(tmpDir);
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("repeats increment occurrences via POST /observation; no direct write", async () => {
    let directOpened = 0;
    const deps: ToolFailureDeps = {
      connect: async () => client,
      openService: () => {
        directOpened++;
        throw new Error("direct path must not be used");
      },
    };
    for (let i = 0; i < 3; i++) {
      const outcome = await processToolFailure(failure(tmpDir), deps);
      expect(outcome).toMatchObject({ captured: true, via: "sidecar" });
    }
    expect(directOpened).toBe(0);

    const rows = errorRows(store, project);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.occurrences).toBe(3);
    expect(rows[0].metadata.source).toBe("auto-capture-failure");
  });

  it("falls back to the deduped direct path when the sidecar call fails", async () => {
    const dbPath = join(tmpDir, "direct.db");
    const outcome = await processToolFailure(failure(tmpDir), {
      connect: async () =>
        ({
          addObservation: async () => {
            throw new Error("sidecar 500");
          },
        }) as unknown as SidecarClient,
      openService: () => new MemoryService(new MemoryStore(dbPath)),
    });
    expect(outcome).toMatchObject({ captured: true, via: "direct" });
    const direct = new MemoryStore(dbPath);
    expect(errorRows(direct, project)).toHaveLength(1);
    direct.close();
  });
});

// ─── Event buffer: error → fix detection on Claude Code ─────────────────────

describe("processToolFailure — event buffer", () => {
  let tmpDir: string;
  let origConnect: typeof SidecarClient.connect;
  const deps: ToolFailureDeps = {
    connect: async () => null,
    openService: () => new MemoryService(new MemoryStore(join(tmpDir, "m.db"))),
  };

  function buffered(): ToolEvent[] {
    return JSON.parse(
      readFileSync(join(tmpDir, ".sentinal", "event-buffer.json"), "utf-8"),
    ) as ToolEvent[];
  }

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir("sentinal-tfo-buffer"));
    origConnect = SidecarClient.connect;
  });

  afterEach(() => {
    SidecarClient.connect = origConnect;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a success:false event carrying the error text", async () => {
    mkdirSync(join(tmpDir, ".sentinal"), { recursive: true });
    const prior: ToolEvent = {
      toolName: "Read",
      success: true,
      timestamp: Date.now() - 1000,
    };
    writeFileSync(
      join(tmpDir, ".sentinal", "event-buffer.json"),
      JSON.stringify([prior]),
    );
    await processToolFailure(failure(tmpDir), deps);
    const events = buffered();
    expect(events).toHaveLength(2);
    expect(events[0].toolName).toBe("Read");
    const last = events[1];
    expect(last.toolName).toBe("Bash");
    expect(last.success).toBe(false);
    expect(last.output).toContain("Cannot find module 'express'");
  });

  it("does not push a no-match exit (not an error worth fixing)", async () => {
    await processToolFailure(
      failure(tmpDir, {
        tool_input: { command: "grep -r needle src" },
        error: "Exit code 1",
      }),
      deps,
    );
    let events: ToolEvent[] = [];
    try {
      events = buffered();
    } catch {
      /* no buffer file at all is fine */
    }
    expect(events.filter((e) => !e.success)).toHaveLength(0);
  });

  it("a failing test run followed by an Edit is captured as a fix by memory-observer", async () => {
    await processToolFailure(
      failure(tmpDir, {
        tool_input: { command: "bun test src/widget.test.ts" },
        error: "Exit code 1\n(fail) widget > renders\n 0 pass\n 1 fail\n",
      }),
      deps,
    );
    const captured: Array<Record<string, unknown>> = [];
    SidecarClient.connect = (async () => ({
      addObservation: async (obs: Record<string, unknown>) => {
        captured.push(obs);
        return { id: 1 };
      },
    })) as unknown as typeof SidecarClient.connect;

    await processMemoryObserver({
      session_id: "s",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(tmpDir, "src", "widget.ts") },
      tool_response: {},
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("fix");
  });
});
