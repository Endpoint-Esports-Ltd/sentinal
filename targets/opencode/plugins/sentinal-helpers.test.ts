/**
 * Sentinal Plugin Helpers Tests
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  getGrepHint,
  getFetchHint,
  transitionTddState,
  resolveProjectRoot,
} from "./sentinal-helpers.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { SidecarClient } from "../../../src/sidecar/client.js";
import { startSidecar, stopSidecar } from "../../../src/sidecar/server.js";
import { makeTmpDir } from "../../../src/test-helpers.js";
import * as fileLogModule from "../../../src/utils/file-log.js";
import { PLUGIN_LOG_FILE, readLastLines } from "../../../src/utils/file-log.js";

describe("getGrepHint", () => {
  it("should return hint for vague grep patterns", () => {
    expect(getGrepHint("how to use React")).not.toBeNull();
    expect(getGrepHint("what is the config")).not.toBeNull();
    expect(getGrepHint("find things that work")).not.toBeNull();
  });

  it("should return null for specific patterns", () => {
    expect(getGrepHint("useState")).toBeNull();
    expect(getGrepHint("class AppComponent")).toBeNull();
  });
});

describe("getFetchHint", () => {
  it("should return a hint string", () => {
    expect(getFetchHint()).toContain("web-fetch");
  });
});

describe("transitionTddState", () => {
  let logDir: string;
  let logDirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logDir = makeTmpDir();
    // Plugin debug log → tmp dir; never the real ~/.sentinal/plugin.debug.log.
    logDirSpy = spyOn(fileLogModule, "getLogDir").mockReturnValue(logDir);
  });

  afterEach(() => {
    logDirSpy.mockRestore();
    rmSync(logDir, { recursive: true, force: true });
  });

  const pluginLog = () =>
    readLastLines(join(logDir, PLUGIN_LOG_FILE), 50).join("\n");

  it("forwards action, specId AND the project to the sidecar (wire contract)", async () => {
    let calledWith: unknown[] | null = null;
    const mockSidecar = {
      tddTransition: async (
        action: "confirm_red" | "confirm_green",
        specId: string | undefined,
        projectPath: string,
      ) => {
        calledWith = [action, specId, projectPath];
        return { count: 2 };
      },
    };

    const result = await transitionTddState(
      mockSidecar,
      "confirm_red",
      "/proj-a",
      "spec-1",
    );

    expect(calledWith!).toEqual(["confirm_red", "spec-1", "/proj-a"]);
    expect(result).toEqual({ count: 2 });
  });

  it("sends specId positionally as undefined when none is given", async () => {
    let calledWith: unknown[] | null = null;
    const mockSidecar = {
      tddTransition: async (...args: unknown[]) => {
        calledWith = args;
        return { count: 0 };
      },
    };

    await transitionTddState(mockSidecar, "confirm_green", "/proj-a");

    expect(calledWith!).toEqual(["confirm_green", undefined, "/proj-a"]);
  });

  it("does not throw on sidecar error, returns null, and LOGS it to the plugin debug log", async () => {
    const failingSidecar = {
      tddTransition: async () => {
        throw new Error("connection failed");
      },
    };

    const result = await transitionTddState(
      failingSidecar,
      "confirm_green",
      "/proj-a",
    );

    expect(result).toBeNull();
    const logged = pluginLog();
    expect(logged).toContain("tdd-transition");
    expect(logged).toContain("confirm_green");
    expect(logged).toContain("/proj-a");
    expect(logged).toContain("connection failed");
  });

  // ── Integration: the REAL helper against the REAL /tdd-state/transition route ──
  describe("against a real sidecar route", () => {
    const PROJECT_A = "/proj-a";
    const PROJECT_B = "/proj-b";
    let tmpDir: string;
    let store: MemoryStore;
    let sidecar: Awaited<ReturnType<typeof startSidecar>>;
    let client: SidecarClient;

    beforeEach(async () => {
      tmpDir = makeTmpDir();
      store = new MemoryStore(join(tmpDir, "test.db"));
      sidecar = await startSidecar({
        store,
        httpOnly: true,
        port: 0,
        enableVectorSearch: false,
      });
      const port = (sidecar.server as unknown as { port: number }).port;
      client = SidecarClient.buildForTest(`http://127.0.0.1:${port}`);

      // tdd_cycles.spec_id is a REAL FK to specs(id) — seed the spec first.
      store.getRawDb().run(
        `INSERT OR IGNORE INTO specs (id, project_path, title, slug, type, status, approved, plan_file, task_count, tasks_done, created_at, updated_at)
           VALUES ('spec-1', '/test', 'Test', 'spec-1', 'feature', 'IN_PROGRESS', 1, '/test.md', 1, 0, ?, ?)`,
        [Date.now(), Date.now()],
      );
      for (const project of [PROJECT_A, PROJECT_B]) {
        store.setTddState({
          filePath: `${project}/src/red.ts`,
          state: "RED_CONFIRMED",
          projectPath: project,
        });
        store.setTddState({
          filePath: `${project}/src/written.ts`,
          state: "TEST_WRITTEN",
          projectPath: project,
          specId: "spec-1",
        });
      }
    });

    afterEach(() => {
      stopSidecar(sidecar.server, sidecar.ctx);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("confirm_green returns a count and leaves ANOTHER project's RED row intact", async () => {
      const result = await transitionTddState(
        client,
        "confirm_green",
        PROJECT_A,
      );

      expect(result).toEqual({ count: 1 });
      expect(store.getTddState(`${PROJECT_A}/src/red.ts`)).toBeNull();
      expect(store.getTddState(`${PROJECT_B}/src/red.ts`)?.state).toBe(
        "RED_CONFIRMED",
      );
      expect(pluginLog()).toBe("");
    });

    it("confirm_red with a specId transitions only this project's rows", async () => {
      const result = await transitionTddState(
        client,
        "confirm_red",
        PROJECT_A,
        "spec-1",
      );

      expect(result).toEqual({ count: 1 });
      expect(store.getTddState(`${PROJECT_A}/src/written.ts`)?.state).toBe(
        "RED_CONFIRMED",
      );
      expect(store.getTddState(`${PROJECT_B}/src/written.ts`)?.state).toBe(
        "TEST_WRITTEN",
      );
    });

    it("a route rejection (blank project) is logged, not swallowed, and nothing is swept", async () => {
      const result = await transitionTddState(client, "confirm_green", "   ");

      expect(result).toBeNull();
      expect(pluginLog()).toContain("tdd-transition");
      expect(pluginLog()).toMatch(/projectPath/);
      for (const project of [PROJECT_A, PROJECT_B]) {
        expect(store.getTddState(`${project}/src/red.ts`)?.state).toBe(
          "RED_CONFIRMED",
        );
      }
    });
  });
});

// ─── resolveProjectRoot ───────────────────────────────────────────────────────

describe("resolveProjectRoot", () => {
  // Helpers for building injected fs fakes
  const makeOpts = (opts: {
    existing?: string[];
    writable?: string[];
    cwd?: string;
  }) => ({
    cwd: () => opts.cwd ?? "/default-cwd",
    exists: (p: string) => (opts.existing ?? []).includes(p),
    isWritable: (p: string) => (opts.writable ?? []).includes(p),
  });

  it("should return worktree when it exists and is writable", () => {
    const result = resolveProjectRoot(
      "/repo",
      "/repo",
      makeOpts({
        existing: ["/repo"],
        writable: ["/repo"],
      }),
    );
    expect(result).toEqual({ root: "/repo" });
  });

  it("should return null when all candidates resolve to filesystem root", () => {
    const result = resolveProjectRoot(
      "/",
      "/",
      makeOpts({
        cwd: "/",
        existing: ["/"],
        writable: ["/"],
      }),
    );
    expect(result.root).toBeNull();
    expect(result.reason).toMatch(/No writable project root found/);
  });

  it("should fall through to directory when worktree is filesystem root", () => {
    const result = resolveProjectRoot(
      "/",
      "/home/user/myproj",
      makeOpts({
        existing: ["/", "/home/user/myproj"],
        writable: ["/", "/home/user/myproj"],
      }),
    );
    expect(result).toEqual({ root: "/home/user/myproj" });
  });

  it("should fall through to cwd when worktree and directory are empty", () => {
    const result = resolveProjectRoot(
      "",
      "",
      makeOpts({
        cwd: "/home/user",
        existing: ["/home/user"],
        writable: ["/home/user"],
      }),
    );
    expect(result).toEqual({ root: "/home/user" });
  });

  it("should return null when worktree, directory, and cwd are all empty", () => {
    const result = resolveProjectRoot(
      undefined,
      undefined,
      makeOpts({
        cwd: "",
      }),
    );
    expect(result.root).toBeNull();
    expect(result.reason).toMatch(/No project root candidates provided/);
  });

  it("should fall through to directory when worktree exists but is not writable", () => {
    const result = resolveProjectRoot(
      "/readonly-path",
      "/writable-dir",
      makeOpts({
        existing: ["/readonly-path", "/writable-dir"],
        writable: ["/writable-dir"],
      }),
    );
    expect(result).toEqual({ root: "/writable-dir" });
  });

  it("should fall through to directory when worktree does not exist", () => {
    const result = resolveProjectRoot(
      "/no-exist",
      "/writable-dir",
      makeOpts({
        existing: ["/writable-dir"],
        writable: ["/writable-dir"],
      }),
    );
    expect(result).toEqual({ root: "/writable-dir" });
  });

  it("should reject Windows drive root and fall through to directory", () => {
    const result = resolveProjectRoot(
      "C:\\",
      "C:\\Users\\me\\proj",
      makeOpts({
        existing: ["C:\\", "C:\\Users\\me\\proj"],
        writable: ["C:\\", "C:\\Users\\me\\proj"],
      }),
    );
    expect(result).toEqual({ root: "C:\\Users\\me\\proj" });
  });

  it("should deduplicate identical candidates", () => {
    // Both worktree and directory are same value — should only try once
    const callLog: string[] = [];
    const result = resolveProjectRoot("/repo", "/repo", {
      cwd: () => "/repo",
      exists: (p) => {
        callLog.push(`exists:${p}`);
        return true;
      },
      isWritable: (p) => {
        callLog.push(`writable:${p}`);
        return true;
      },
    });
    expect(result).toEqual({ root: "/repo" });
    // /repo should appear only once in exists/writable calls (deduplicated)
    expect(callLog.filter((c) => c === "exists:/repo").length).toBe(1);
  });

  it("should return null with reason listing tried paths when all fail", () => {
    const result = resolveProjectRoot(
      "/a",
      "/b",
      makeOpts({
        cwd: "/c",
        existing: ["/a", "/b", "/c"],
        writable: [], // nothing writable
      }),
    );
    expect(result.root).toBeNull();
    expect(result.reason).toContain("/a");
    expect(result.reason).toContain("/b");
    expect(result.reason).toContain("/c");
  });
});

// ─── OC parity smoke tests ────────────────────────────────────────────────────
// These verify that the shared hook functions used by the OpenCode plugin
// are importable and callable without throwing.

describe("processInstructionsLoaded — OC parity", () => {
  it("should be importable from src/hooks/instructions-loaded", async () => {
    const { processInstructionsLoaded } =
      await import("../../../src/hooks/instructions-loaded.js");
    expect(typeof processInstructionsLoaded).toBe("function");
  });

  it("should not throw for compact load_reason (skip path)", async () => {
    const { processInstructionsLoaded } =
      await import("../../../src/hooks/instructions-loaded.js");
    await expect(
      processInstructionsLoaded({
        session_id: "s1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp",
        permission_mode: "default",
        hook_event_name: "InstructionsLoaded",
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "compact",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("processPostCompact — OC parity", () => {
  it("should be importable from src/hooks/post-compact", async () => {
    const { processPostCompact } =
      await import("../../../src/hooks/post-compact.js");
    expect(typeof processPostCompact).toBe("function");
  });

  it("should return a message string when compact-state.json is missing", async () => {
    const { processPostCompact } =
      await import("../../../src/hooks/post-compact.js");
    const result = await processPostCompact({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/nonexistent-dir-for-test",
      permission_mode: "default",
      hook_event_name: "PostCompact",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("compacted");
  });
});

describe("processTaskCreated — OC parity", () => {
  it("should be importable from src/hooks/task-created", async () => {
    const { processTaskCreated } =
      await import("../../../src/hooks/task-created.js");
    expect(typeof processTaskCreated).toBe("function");
  });

  it("should be callable as an async function", async () => {
    const { processTaskCreated } =
      await import("../../../src/hooks/task-created.js");
    // The function is async and returns void — just verify it's callable
    expect(typeof processTaskCreated).toBe("function");
    // Verify it returns a Promise (async function)
    const result = processTaskCreated({
      session_id: "s1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "TaskCreated",
      task_id: "task-001",
      task_subject: "Test task",
      task_description: "A test task",
    });
    expect(result).toBeInstanceOf(Promise);
    // Let it resolve (may or may not call sidecar depending on test environment)
    await result.catch(() => {
      /* any sidecar error is fine */
    });
  });
});
