/**
 * TDD Tracker Hook Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import {
  processTddTracking,
  hasTestFailure,
  hasTestPass,
  getImplPathForTest,
  trackerInputFromHook,
} from "./tdd-tracker.js";
import type { HookInput } from "../utils/hook-output.js";
import { resolveProjectIdentity } from "../project/identity.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writePlan(dir: string, filename: string, content: string): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const filePath = join(plansDir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

const activePlanContent = `# Active Spec
Status: IN PROGRESS
Type: Feature

## Implementation Tasks

### 1. First task
- **Status:** in-progress
`;

const FAIL_OUTPUT = "3 fail\n1 pass\nAssertionError: expected 1 to be 2";

// ─── Helper indicator tests ───────────────────────────────────────────────────

describe("hasTestFailure", () => {
  it("detects '3 fail'", () => expect(hasTestFailure("3 fail\n")).toBe(true));
  it("detects 'tests failed'", () =>
    expect(hasTestFailure("2 tests failed")).toBe(true));
  it("detects AssertionError", () =>
    expect(hasTestFailure("AssertionError: expected")).toBe(true));
  it("returns false for passing output", () =>
    expect(hasTestFailure("5 pass")).toBe(false));
  it("returns false for empty string", () =>
    expect(hasTestFailure("")).toBe(false));
});

describe("hasTestPass", () => {
  it("detects '5 pass'", () => expect(hasTestPass("5 pass")).toBe(true));
  it("detects 'tests passed'", () =>
    expect(hasTestPass("All tests passed")).toBe(true));
  it("detects 'Tests: 10 passed'", () =>
    expect(hasTestPass("Tests: 10 passed")).toBe(true));
  it("returns false for failing output", () =>
    expect(hasTestPass("3 fail")).toBe(false));
  it("returns false for empty string", () =>
    expect(hasTestPass("")).toBe(false));
});

describe("getImplPathForTest", () => {
  it("maps .test.ts to .ts", () =>
    expect(getImplPathForTest("src/foo/bar.test.ts")).toBe("src/foo/bar.ts"));
  it("maps .spec.ts to .ts", () =>
    expect(getImplPathForTest("src/foo/bar.spec.ts")).toBe("src/foo/bar.ts"));
  it("maps .test.js to .js", () =>
    expect(getImplPathForTest("src/foo/bar.test.js")).toBe("src/foo/bar.js"));
  it("returns null for non-test file", () =>
    expect(getImplPathForTest("src/foo/bar.ts")).toBeNull());
});

// ─── processTddTracking integration tests ─────────────────────────────────────

describe("processTddTracking", () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;
  let specStore: SpecStore;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, "test.db");
    memoryStore = new MemoryStore(dbPath);
    specStore = new SpecStore(memoryStore);

    // Write and sync an active plan
    const planFile = writePlan(tmpDir, "active-spec.md", activePlanContent);
    specStore.syncFromPlanFile(planFile, tmpDir);
    memoryStore.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("test file write transitions state to TEST_WRITTEN", () => {
    it("sets state to TEST_WRITTEN when a test file is written", async () => {
      // Open a fresh store to verify the tracker's logic
      const store = new MemoryStore(dbPath);
      const ss = new SpecStore(store);
      const spec = ss.getCurrentSpec(tmpDir);
      expect(spec).not.toBeNull();

      const task = ss.getCurrentTask(spec!.id);
      store.setTddState({
        filePath: "src/auth.ts",
        state: "TEST_WRITTEN",
        specId: spec!.id,
        taskPosition: task?.position ?? null,
        testFilePath: "src/auth.test.ts",
      });

      const cycle = store.getTddState("src/auth.ts");
      expect(cycle!.state).toBe("TEST_WRITTEN");
      expect(cycle!.testFilePath).toBe("src/auth.test.ts");
      store.close();
    });
  });

  describe("test failure transitions TEST_WRITTEN → RED_CONFIRMED", () => {
    it("updates state to RED_CONFIRMED for TEST_WRITTEN cycles", async () => {
      const store = new MemoryStore(dbPath);
      const ss = new SpecStore(store);
      const spec = ss.getCurrentSpec(tmpDir);

      store.setTddState({
        filePath: "src/auth.ts",
        state: "TEST_WRITTEN",
        specId: spec!.id,
      });

      // Simulate the tracker logic for test failure
      const states = store.listActiveTddStates(spec!.id);
      for (const cycle of states) {
        if (cycle.state === "TEST_WRITTEN") {
          store.setTddState({
            filePath: cycle.filePath,
            state: "RED_CONFIRMED",
            lastFailOutput: FAIL_OUTPUT.slice(0, 2000),
          });
        }
      }

      const cycle = store.getTddState("src/auth.ts");
      expect(cycle!.state).toBe("RED_CONFIRMED");
      expect(cycle!.lastFailOutput).toContain("3 fail");
      store.close();
    });
  });

  describe("test pass transitions RED_CONFIRMED → cleared (GREEN_CONFIRMED → IDLE)", () => {
    it("clears state on test pass after RED_CONFIRMED", async () => {
      const store = new MemoryStore(dbPath);
      const ss = new SpecStore(store);
      const spec = ss.getCurrentSpec(tmpDir);

      store.setTddState({
        filePath: "src/auth.ts",
        state: "RED_CONFIRMED",
        specId: spec!.id,
      });

      // Simulate tracker logic for test pass
      const states = store.listActiveTddStates(spec!.id);
      for (const cycle of states) {
        if (cycle.state === "RED_CONFIRMED") {
          store.clearTddState(cycle.filePath);
        }
      }

      expect(store.getTddState("src/auth.ts")).toBeNull();
      store.close();
    });

    it("only clears RED_CONFIRMED states, not TEST_WRITTEN", async () => {
      const store = new MemoryStore(dbPath);
      const ss = new SpecStore(store);
      const spec = ss.getCurrentSpec(tmpDir);

      store.setTddState({
        filePath: "src/a.ts",
        state: "RED_CONFIRMED",
        specId: spec!.id,
      });
      store.setTddState({
        filePath: "src/b.ts",
        state: "TEST_WRITTEN",
        specId: spec!.id,
      });

      const states = store.listActiveTddStates(spec!.id);
      for (const cycle of states) {
        if (cycle.state === "RED_CONFIRMED") {
          store.clearTddState(cycle.filePath);
        }
      }

      expect(store.getTddState("src/a.ts")).toBeNull();
      expect(store.getTddState("src/b.ts")).not.toBeNull();
      store.close();
    });
  });

  describe("no active spec — no state changes", () => {
    it("does not set state when no active spec", async () => {
      const store = new MemoryStore(dbPath);
      const ss = new SpecStore(store);
      // Use a different cwd with no spec
      const spec = ss.getCurrentSpec("/tmp/no-spec-project");
      expect(spec).toBeNull();

      // No state should be set because there's no spec to scope to
      const states = store.listActiveTddStates(null);
      expect(states).toHaveLength(0);
      store.close();
    });
  });
});

// ─── Task 9: every tracker write records a canonical project ──────────────────
//
// Drives the REAL processTddTracking (which opens `new MemoryStore()` →
// $SENTINAL_HOME/memory.db) from inside a linked git worktree, so identity
// (main checkout) and workspace (the worktree) genuinely differ.

describe("processTddTracking records the project (Pre-Mortem 3)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let mainRoot: string;
  let worktreePath: string;
  const OTHER = "/other/project";

  function git(args: string[], cwd: string): void {
    Bun.spawnSync(["git", ...args], { cwd });
  }

  function openStore(): MemoryStore {
    return new MemoryStore(join(tmpDir, "home", "memory.db"));
  }

  function nullProjectRows(store: MemoryStore): number {
    return (
      store
        .getRawDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM tdd_cycles WHERE project_path IS NULL",
        )
        .get() as { n: number }
    ).n;
  }

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    mkdirSync(join(tmpDir, "home"), { recursive: true });
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmpDir, "home");

    const repo = join(tmpDir, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# t\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    worktreePath = join(tmpDir, "wt");
    git(["worktree", "add", "-b", "feature", worktreePath, "main"], repo);
    mainRoot = realpathSync(repo);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("D6: with a same-named plan in ANOTHER project, the cycle, its task and its event use THIS project's key", async () => {
    const plan =
      "# Twin\n\nStatus: IN_PROGRESS\nType: Feature\n\n## Progress Tracking\n\n- [x] Task 1: done\n- [ ] Task 2: next\n";
    const mine = join(mainRoot, "docs", "plans");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "2026-01-01-twin.md"), plan);
    const theirsDir = join(tmpDir, "theirs", "docs", "plans");
    mkdirSync(theirsDir, { recursive: true });
    writeFileSync(
      join(theirsDir, "2026-01-01-twin.md"),
      plan.replace("- [x]", "- [ ]"),
    );
    let store = openStore();
    const ss = new SpecStore(store);
    ss.syncFromPlanFile(join(theirsDir, "2026-01-01-twin.md"), OTHER);
    ss.syncFromPlanFile(join(mine, "2026-01-01-twin.md"), mainRoot);
    store.close();

    await processTddTracking({
      toolName: "Write",
      filePath: join(worktreePath, "src", "twin.test.ts"),
      cwd: worktreePath,
    });

    store = openStore();
    const row = store.getTddState(join(worktreePath, "src", "twin.ts"))!;
    expect(row.specId).toBe(`${mainRoot}::2026-01-01-twin`);
    expect(row.taskPosition).toBe(2); // THIS project's current task, not OTHER's 1
    const events = store.getSpecEvents(`${mainRoot}::2026-01-01-twin`);
    expect(events.map((e) => e.eventType)).toContain("tdd_cycle");
    expect(store.getSpecEvents(`${OTHER}::2026-01-01-twin`)).toHaveLength(0);
    store.close();
  }, 30_000);

  it("TEST_WRITTEN write records the main-checkout identity, not the worktree", async () => {
    expect(worktreePath).not.toBe(mainRoot);
    const testFile = join(worktreePath, "src", "foo.test.ts");

    await processTddTracking({
      toolName: "Write",
      filePath: testFile,
      cwd: worktreePath,
    });

    const store = openStore();
    const row = store.getTddState(join(worktreePath, "src", "foo.ts"))!;
    expect(row.state).toBe("TEST_WRITTEN");
    expect(row.projectPath).toBe(mainRoot);
    expect(nullProjectRows(store)).toBe(0);
    store.close();
  }, 30_000);

  it("RED transition touches only this project's rows and keeps them scoped", async () => {
    const own = join(worktreePath, "src", "own.ts");
    const theirs = "/other/project/src/theirs.ts";
    let store = openStore();
    store.setTddState({
      filePath: own,
      state: "TEST_WRITTEN",
      projectPath: mainRoot,
    });
    store.setTddState({
      filePath: theirs,
      state: "TEST_WRITTEN",
      projectPath: OTHER,
    });
    store.close();

    await processTddTracking({
      toolName: "Bash",
      bashOutput: FAIL_OUTPUT,
      cwd: worktreePath,
    });

    store = openStore();
    expect(store.getTddState(own)!.state).toBe("RED_CONFIRMED");
    expect(store.getTddState(own)!.projectPath).toBe(mainRoot);
    // The other project's row is neither transitioned nor re-keyed.
    expect(store.getTddState(theirs)!.state).toBe("TEST_WRITTEN");
    expect(store.getTddState(theirs)!.projectPath).toBe(OTHER);
    expect(nullProjectRows(store)).toBe(0);
    store.close();
  }, 30_000);

  it("GREEN clears only this project's RED rows", async () => {
    const own = join(worktreePath, "src", "own.ts");
    const theirs = "/other/project/src/theirs.ts";
    let store = openStore();
    store.setTddState({
      filePath: own,
      state: "RED_CONFIRMED",
      projectPath: mainRoot,
    });
    store.setTddState({
      filePath: theirs,
      state: "RED_CONFIRMED",
      projectPath: OTHER,
    });
    store.close();

    // Not PASS_OUTPUT: its "0 fail" matches TEST_FAIL_INDICATORS (/\d+\s+fail/),
    // so the real tracker routes it to the RED branch (pre-existing quirk).
    await processTddTracking({
      toolName: "Bash",
      bashOutput: "5 pass\nAll tests passed",
      cwd: worktreePath,
    });

    store = openStore();
    expect(store.getTddState(own)).toBeNull();
    expect(store.getTddState(theirs)!.state).toBe("RED_CONFIRMED");
    store.close();
  }, 30_000);
});

// ─── Task 10: the hook reads Claude Code's REAL Bash payload ──────────────────
//
// Claude Code's Bash tool_response is {stdout, stderr, interrupted, isImage,
// noOutputExpected}; there is no `output`. Before this, the tracker read
// `tool_response.output`, so on Claude Code RED/GREEN never fired.

describe("trackerInputFromHook + processTddTracking (real payload shapes)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let project: string;
  const impl = "/proj/src/widget.ts";

  function openStore(): MemoryStore {
    return new MemoryStore(join(tmpDir, "home", "memory.db"));
  }

  function hookInput(extra: Partial<HookInput>): HookInput {
    return {
      session_id: "s",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      ...extra,
    };
  }

  function seed(state: "TEST_WRITTEN" | "RED_CONFIRMED"): void {
    const store = openStore();
    store.setTddState({ filePath: impl, state, projectPath: project });
    store.close();
  }

  function stateOf(): string | null {
    const store = openStore();
    const row = store.getTddState(impl);
    store.close();
    return row?.state ?? null;
  }

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    mkdirSync(join(tmpDir, "home"), { recursive: true });
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmpDir, "home");
    project = resolveProjectIdentity(tmpDir);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts bashOutput from tool_response.stdout/stderr", () => {
    const t = trackerInputFromHook(
      hookInput({
        tool_response: { stdout: "out", stderr: "err", interrupted: false },
      }),
    );
    expect(t.toolName).toBe("Bash");
    expect(t.bashOutput).toBe("out\nerr");
    expect(t.cwd).toBe(tmpDir);
  });

  it("gives non-Bash tools no bashOutput but keeps the file path", () => {
    const t = trackerInputFromHook(
      hookInput({
        tool_name: "Write",
        tool_input: { file_path: "/proj/src/widget.test.ts" },
        tool_response: { stdout: "ignored" },
      }),
    );
    expect(t.bashOutput).toBeUndefined();
    expect(t.filePath).toBe("/proj/src/widget.test.ts");
  });

  it("a failing run's stdout moves TEST_WRITTEN → RED_CONFIRMED", async () => {
    seed("TEST_WRITTEN");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          tool_response: {
            stdout:
              "src/widget.test.ts:\n(fail) widget > renders\n\n 0 pass\n 1 fail\n 1 expect() calls\n",
            stderr: "",
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
          },
        }),
      ),
    );
    expect(stateOf()).toBe("RED_CONFIRMED");
  }, 30_000);

  it("a PostToolUseFailure `error` string is recognised as failing", async () => {
    seed("TEST_WRITTEN");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          hook_event_name: "PostToolUseFailure",
          tool_use_id: "toolu_01",
          error:
            "Exit code 1\nsrc/widget.test.ts:\n(fail) widget > renders\n 0 pass\n 1 fail\n",
          is_interrupt: false,
          duration_ms: 900,
        }),
      ),
    );
    expect(stateOf()).toBe("RED_CONFIRMED");
  }, 30_000);

  it("a passing run's stdout moves RED_CONFIRMED → cleared (GREEN)", async () => {
    seed("RED_CONFIRMED");
    // Realistic jest summary. See the it.failing below for bun's format.
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          tool_response: {
            stdout:
              "PASS src/widget.test.ts\nTest Suites: 1 passed, 1 total\nTests:       12 passed, 12 total\n",
            stderr: "",
            interrupted: false,
          },
        }),
      ),
    );
    expect(stateOf()).toBeNull();
  }, 30_000);

  it("the legacy {output} shape still reaches the tracker", async () => {
    seed("TEST_WRITTEN");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({ tool_response: { output: " 0 pass\n 3 fail\n" } }),
      ),
    );
    expect(stateOf()).toBe("RED_CONFIRMED");
  }, 30_000);

  // Regression: a real passing `bun test` ALWAYS prints " 0 fail". The fail
  // indicator used to be /\d+\s+fail/, so a passing bun run was routed to the
  // RED branch and GREEN never fired on either target. capture.ts now requires
  // a non-zero count.
  it("a real passing bun run moves RED_CONFIRMED → cleared", async () => {
    seed("RED_CONFIRMED");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          tool_response: {
            stdout:
              " 12 pass\n 0 fail\n 30 expect() calls\nRan 12 tests across 1 file. [120.00ms]\n",
            stderr: "",
            interrupted: false,
          },
        }),
      ),
    );
    expect(stateOf()).toBeNull();
  }, 30_000);

  // Task 11: hooks.json routes Bash PostToolUseFailure to this tracker too.
  // PostToolUse (success) and PostToolUseFailure (failure) are mutually
  // exclusive per call; a TDD cycle sees one of each across its two runs.
  it("full cycle across both events: failure → RED, then success → cleared", async () => {
    seed("TEST_WRITTEN");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          hook_event_name: "PostToolUseFailure",
          error:
            "Exit code 1\nsrc/widget.test.ts:\n(fail) widget > renders [0.3ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file. [15.00ms]\n",
          is_interrupt: false,
        }),
      ),
    );
    expect(stateOf()).toBe("RED_CONFIRMED");

    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          tool_response: {
            stdout: "",
            stderr:
              "src/widget.test.ts:\n(pass) widget > renders [0.2ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [14.00ms]\n",
            interrupted: false,
          },
        }),
      ),
    );
    expect(stateOf()).toBeNull();
  }, 30_000);

  it("the same failing run delivered on both events confirms RED once and stays RED", async () => {
    seed("TEST_WRITTEN");
    const text = "(fail) widget > renders\n 0 pass\n 2 fail\n";
    await processTddTracking(
      trackerInputFromHook(
        hookInput({ tool_response: { stdout: text, stderr: "" } }),
      ),
    );
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          hook_event_name: "PostToolUseFailure",
          error: `Exit code 1\n${text}`,
        }),
      ),
    );
    expect(stateOf()).toBe("RED_CONFIRMED");
  }, 30_000);

  it("a failing Edit's PostToolUseFailure never touches the cycle", async () => {
    seed("TEST_WRITTEN");
    await processTddTracking(
      trackerInputFromHook(
        hookInput({
          hook_event_name: "PostToolUseFailure",
          tool_name: "Edit",
          tool_input: { file_path: "/proj/src/widget.ts" },
          error: "String to replace not found in file. 1 fail",
        }),
      ),
    );
    expect(stateOf()).toBe("TEST_WRITTEN");
  }, 30_000);
});

// ─── Task 10: the spec lookup uses the canonical identity, not the raw cwd ───

import { spyOn } from "bun:test";

describe("processTddTracking — spec lookup key (Task 10)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir("tdd-tracker-key"); // raw `/var/…` on macOS
    mkdirSync(join(tmpDir, "home"), { recursive: true });
    mkdirSync(join(tmpDir, "repo", "src"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
      cwd: join(tmpDir, "repo"),
    });
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmpDir, "home");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls getCurrentSpec with resolveProjectIdentity(cwd)", async () => {
    const cwd = join(tmpDir, "repo", "src");
    const spy = spyOn(SpecStore.prototype, "getCurrentSpec");
    try {
      await processTddTracking({
        toolName: "Write",
        filePath: join(cwd, "a.test.ts"),
        cwd,
      });
      expect(spy.mock.calls[0]![0]).toBe(realpathSync(join(tmpDir, "repo")));
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

// ─── Task 1 (2026-09-28): transitions scoped to the tests that ran ──────────

describe("processTddTracking — scoped to the tests that ran (D1/D2/D3)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let project: string;
  let A: string;
  let B: string;
  const PASS = " 1 pass\n 0 fail\nRan 1 tests across 1 file. [10.00ms]\n";
  const FAIL = " 0 pass\n 1 fail\n";

  const openStore = (): MemoryStore =>
    new MemoryStore(join(tmpDir, "home", "memory.db"));

  function seed(
    state: "TEST_WRITTEN" | "RED_CONFIRMED",
    withTestPath = true,
  ): void {
    const store = openStore();
    for (const impl of [A, B]) {
      store.setTddState({
        filePath: impl,
        state,
        testFilePath: withTestPath
          ? impl.replace(/\.ts$/, ".test.ts")
          : undefined,
        projectPath: project,
      });
    }
    store.close();
  }

  function stateOf(file: string): string | null {
    const store = openStore();
    const row = store.getTddState(file);
    store.close();
    return row?.state ?? null;
  }

  function bash(command: string, stdout: string): HookInput {
    return {
      session_id: "s",
      transcript_path: "",
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: "", interrupted: false },
    };
  }

  const run = (input: HookInput) =>
    processTddTracking(trackerInputFromHook(input));

  beforeEach(() => {
    tmpDir = realpathSync(makeTmpDir());
    mkdirSync(join(tmpDir, "home"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    // Test-file args only narrow a run when the file exists.
    for (const f of ["src/a.test.ts", "src/b.test.ts", "tests/b.test.ts"])
      writeFileSync(join(tmpDir, f), "");
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmpDir, "home");
    project = resolveProjectIdentity(tmpDir);
    A = join(tmpDir, "src", "a.ts");
    B = join(tmpDir, "src", "b.ts");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("trackerInputFromHook carries tool_input.command", () => {
    expect(trackerInputFromHook(bash("bun test x.test.ts", PASS)).command).toBe(
      "bun test x.test.ts",
    );
  });

  it("THE RACE (CC): a passing `bun test <B's test>` leaves A RED", async () => {
    seed("RED_CONFIRMED");
    await run(bash("bun test src/b.test.ts", PASS));
    expect(stateOf(A)).toBe("RED_CONFIRMED");
    expect(stateOf(B)).toBeNull();
  }, 30_000);

  it("a failing `bun test <B's test>` confirms RED only for B", async () => {
    seed("TEST_WRITTEN");
    await run(bash("bun test src/b.test.ts", FAIL));
    expect(stateOf(A)).toBe("TEST_WRITTEN");
    expect(stateOf(B)).toBe("RED_CONFIRMED");
  }, 30_000);

  it("a full `bun test` (no args) still clears project-wide", async () => {
    seed("RED_CONFIRMED");
    await run(bash("bun test", PASS));
    expect(stateOf(A)).toBeNull();
    expect(stateOf(B)).toBeNull();
  }, 30_000);

  it("a `-t`-filtered passing run does not confirm GREEN", async () => {
    seed("RED_CONFIRMED");
    await run(bash("bun test -t 'renders' src/b.test.ts", PASS));
    expect(stateOf(A)).toBe("RED_CONFIRMED");
    expect(stateOf(B)).toBe("RED_CONFIRMED");
  }, 30_000);

  it("tests/ layout, rows without test_file_path (tdd_set_state)", async () => {
    seed("RED_CONFIRMED", false);
    await run(bash("bun test tests/b.test.ts", PASS));
    expect(stateOf(A)).toBe("RED_CONFIRMED");
    expect(stateOf(B)).toBeNull();
  }, 30_000);

  it("D3: re-editing a test does not downgrade a RED impl to TEST_WRITTEN", async () => {
    seed("RED_CONFIRMED");
    await run({
      ...bash("", ""),
      tool_name: "Edit",
      tool_input: { file_path: join(tmpDir, "src", "a.test.ts") },
      tool_response: {},
    });
    expect(stateOf(A)).toBe("RED_CONFIRMED");
  }, 30_000);
});

// ─── Cross-project: rows keyed and transitioned per file project (Phase 1) ──

describe("processTddTracking — per-project rows (cross-project scope)", () => {
  let tmp: string;
  let savedHome: string | undefined;
  let a: string;
  let b: string;
  let c: string;
  const PASS = " 1 pass\n 0 fail\nRan 1 tests across 1 file. [10.00ms]\n";
  const FAIL = " 0 pass\n 1 fail\n";

  const openStore = (): MemoryStore =>
    new MemoryStore(join(tmp, "home", "memory.db"));

  function initRepo(dir: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
    for (const f of ["x.test.ts", "y.test.ts"])
      writeFileSync(join(dir, "src", f), "");
  }

  function seed(file: string, project: string, state: string): void {
    const store = openStore();
    store.setTddState({
      filePath: file,
      state: state as "TEST_WRITTEN",
      testFilePath: file.replace(/\.ts$/, ".test.ts"),
      projectPath: project,
    });
    store.close();
  }

  function row(file: string) {
    const store = openStore();
    const r = store.getTddState(file);
    store.close();
    return r;
  }

  function activate(project: string, slug: string): string {
    const store = openStore();
    const ss = new SpecStore(store);
    ss.syncFromPlanFile(
      writePlan(project, `${slug}.md`, activePlanContent),
      project,
    );
    const spec = ss.getCurrentSpec(project)!;
    store.close();
    return spec.key ?? spec.id;
  }

  const bash = (command: string, out: string) =>
    processTddTracking({
      toolName: "Bash",
      command,
      bashOutput: out,
      cwd: a,
      sessionId: "s",
    });

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("tdd-tracker-cross"));
    mkdirSync(join(tmp, "home"), { recursive: true });
    a = join(tmp, "a");
    b = join(tmp, "b");
    c = join(tmp, "c");
    for (const d of [a, b, c]) initRepo(d);
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmp, "home");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cd ../b && bun test src/x.test.ts: failing → B's row RED, passing → cleared", async () => {
    const bx = join(b, "src", "x.ts");
    seed(bx, b, "TEST_WRITTEN");
    await bash("cd ../b && bun test src/x.test.ts", FAIL);
    expect(row(bx)?.state).toBe("RED_CONFIRMED");
    expect(row(bx)?.projectPath).toBe(b);
    await bash("cd ../b && bun test src/x.test.ts", PASS);
    expect(row(bx)).toBeNull();
  }, 30_000);

  it("a project-wide run after cd covers the cd target's project only", async () => {
    const ax = join(a, "src", "x.ts");
    const bx = join(b, "src", "x.ts");
    seed(ax, a, "RED_CONFIRMED");
    seed(bx, b, "RED_CONFIRMED");
    await bash("cd ../b && bun test", PASS);
    expect(row(bx)).toBeNull();
    expect(row(ax)?.state).toBe("RED_CONFIRMED");
  }, 30_000);

  it("a mixed run transitions each project's row under its own key; others untouched", async () => {
    const ax = join(a, "src", "x.ts");
    const by = join(b, "src", "y.ts");
    const cz = join(c, "src", "x.ts");
    seed(ax, a, "TEST_WRITTEN");
    seed(by, b, "TEST_WRITTEN");
    seed(cz, c, "RED_CONFIRMED");
    await bash("bun test src/x.test.ts ../b/src/y.test.ts", FAIL);
    expect(row(ax)).toMatchObject({ state: "RED_CONFIRMED", projectPath: a });
    expect(row(by)).toMatchObject({ state: "RED_CONFIRMED", projectPath: b });
    await bash("bun test src/x.test.ts ../b/src/y.test.ts", PASS);
    expect(row(ax)).toBeNull();
    expect(row(by)).toBeNull();
    expect(row(cz)).toMatchObject({ state: "RED_CONFIRMED", projectPath: c });
  }, 30_000);

  it("editing B's test from session A keys the row to B (spec: A's when B has none)", async () => {
    const aKey = activate(a, "a-plan");
    await processTddTracking({
      toolName: "Write",
      filePath: join(b, "src", "x.test.ts"),
      cwd: a,
    });
    expect(row(join(b, "src", "x.ts"))).toMatchObject({
      state: "TEST_WRITTEN",
      projectPath: b,
      specId: aKey,
    });
  }, 30_000);

  it("editing B's test uses B's own spec when it has one", async () => {
    activate(a, "a-plan");
    const bKey = activate(b, "b-plan");
    await processTddTracking({
      toolName: "Write",
      filePath: join(b, "src", "x.test.ts"),
      cwd: a,
    });
    expect(row(join(b, "src", "x.ts"))?.specId).toBe(bKey);
  }, 30_000);

  it("ordering: a B row written under A's plan still clears after B gets its own plan", async () => {
    activate(a, "a-plan");
    await processTddTracking({
      toolName: "Write",
      filePath: join(b, "src", "x.test.ts"),
      cwd: a,
    });
    activate(b, "b-plan");
    const bx = join(b, "src", "x.ts");
    await bash("bun test ../b/src/x.test.ts", FAIL);
    expect(row(bx)?.state).toBe("RED_CONFIRMED");
    await bash("bun test ../b/src/x.test.ts", PASS);
    expect(row(bx)).toBeNull();
  }, 30_000);

  it("a -t filtered passing run confirms GREEN in no group", async () => {
    const ax = join(a, "src", "x.ts");
    const by = join(b, "src", "y.ts");
    seed(ax, a, "RED_CONFIRMED");
    seed(by, b, "RED_CONFIRMED");
    await bash("bun test -t foo src/x.test.ts ../b/src/y.test.ts", PASS);
    expect(row(ax)?.state).toBe("RED_CONFIRMED");
    expect(row(by)?.state).toBe("RED_CONFIRMED");
  }, 30_000);
});
