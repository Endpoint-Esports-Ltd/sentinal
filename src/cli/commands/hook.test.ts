import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../memory/store.js";
import { resolveProjectIdentity } from "../../project/identity.js";

const CLI = join(import.meta.dir, "..", "index.ts");

/**
 * CLI wiring tests — these spawn the real dispatcher because hook handlers
 * that block call process.exit() and cannot be unit-tested in-process.
 */
describe("sentinal hook claude file-checker (CLI wiring)", () => {
  let dir: string;
  let bigFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinal-hook-cli-"));
    bigFile = join(dir, "big.ts");
    const lines = Array.from(
      { length: 650 },
      (_, i) => `export const v${i} = ${i};`,
    );
    writeFileSync(bigFile, lines.join("\n"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runFileChecker(filePath: string) {
    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "/tmp/t",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath },
    });
    return Bun.spawnSync(["bun", CLI, "hook", "claude", "file-checker"], {
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  it("exits 2 with decision:block when the file violates limits", () => {
    const result = runFileChecker(bigFile);
    expect(result.exitCode).toBe(2);

    // continueOnBlock requires the block decision on stdout…
    const stdout = result.stdout.toString();
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("650 lines");

    // …and Claude Code only surfaces exit-2 reasons from stderr.
    expect(result.stderr.toString()).toContain("650 lines");
  }, 30_000);

  it("exits 0 silently when the file is clean", () => {
    const cleanFile = join(dir, "clean.test.ts");
    writeFileSync(cleanFile, "export const ok = 1;\n");
    const result = runFileChecker(cleanFile);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});

/**
 * `sentinal hook shared tdd-tracker` must read Claude Code's documented Bash
 * tool_response ({stdout, stderr, interrupted, …} — no `output` field).
 */
describe("sentinal hook shared tdd-tracker (CLI wiring)", () => {
  let dir: string;
  let home: string;
  const impl = "/proj/src/widget.ts";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-hook-tdd-")));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves TEST_WRITTEN → RED_CONFIRMED from tool_response.stdout", () => {
    const dbPath = join(home, "memory.db");
    let store = new MemoryStore(dbPath);
    store.setTddState({
      filePath: impl,
      state: "TEST_WRITTEN",
      projectPath: resolveProjectIdentity(dir),
    });
    store.close();

    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "/tmp/t",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_use_id: "toolu_01",
      tool_response: {
        stdout: "src/widget.test.ts:\n 0 pass\n 1 fail\n",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    });
    const result = Bun.spawnSync(
      ["bun", CLI, "hook", "shared", "tdd-tracker"],
      {
        stdin: Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SENTINAL_HOME: home },
      },
    );
    expect(result.exitCode).toBe(0);

    store = new MemoryStore(dbPath);
    expect(store.getTddState(impl)?.state).toBe("RED_CONFIRMED");
    store.close();
  }, 30_000);
});

// ─── PostToolUseFailure (Task 11) ────────────────────────────────────────────

const HOOKS_JSON = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "targets",
  "claude-code",
  "hooks",
  "hooks.json",
);

interface HookEntry {
  type: string;
  command: string;
  args: string[];
  timeout?: number;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/**
 * Claude Code's matcher rule: only [A-Za-z0-9_\- ,|] → exact names split on
 * `|`/`,`; anything else → an UNANCHORED JavaScript regex.
 */
function matcherMatches(matcher: string, tool: string): boolean {
  if (/^[A-Za-z0-9_\- ,|]*$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .includes(tool);
  }
  return new RegExp(matcher).test(tool);
}

describe("hooks.json — PostToolUseFailure entries", () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, "utf-8"));
  const groups: HookGroup[] = config.hooks.PostToolUseFailure ?? [];

  function groupRunning(name: string): HookGroup | undefined {
    return groups.find((g) =>
      g.hooks.some((h) => h.args.join(" ") === `hook shared ${name}`),
    );
  }

  it("registers tool-failure-observer async with an explicit timeout", () => {
    const g = groupRunning("tool-failure-observer");
    expect(g).toBeDefined();
    const h = g!.hooks[0];
    expect(h.type).toBe("command");
    expect(h.command).toBe("sentinal");
    expect(h.async).toBe(true);
    expect(typeof h.timeout).toBe("number");
  });

  it("its matcher covers the worth-capturing tools and nothing else", () => {
    const m = groupRunning("tool-failure-observer")!.matcher!;
    for (const tool of [
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "mcp__github__create_issue",
      "mcp__plugin_sentinal_sentinal__worktree_sync",
    ]) {
      expect(matcherMatches(m, tool)).toBe(true);
    }
    for (const tool of [
      "NotebookEdit",
      "BashOutput",
      "Task",
      "TodoWrite",
      "WebSearch",
      "ReadMcpResourceTool",
    ]) {
      expect(matcherMatches(m, tool)).toBe(false);
    }
  });

  it("routes Bash failures to tdd-tracker, async with an explicit timeout", () => {
    const g = groupRunning("tdd-tracker");
    expect(g).toBeDefined();
    expect(g!.matcher).toBe("Bash");
    expect(g!.hooks[0].async).toBe(true);
    expect(typeof g!.hooks[0].timeout).toBe("number");
  });
});

describe("sentinal hook shared tool-failure-observer (CLI wiring)", () => {
  let dir: string;
  let home: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-hook-tfo-")));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores one error observation in the isolated home (no sidecar there)", () => {
    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "/tmp/t",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "Run test suite" },
      tool_use_id: "toolu_01ABC123",
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
      duration_ms: 4187,
    });
    const result = Bun.spawnSync(
      ["bun", CLI, "hook", "shared", "tool-failure-observer"],
      {
        stdin: Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SENTINAL_HOME: home },
      },
    );
    expect(result.exitCode).toBe(0);

    const store = new MemoryStore(join(home, "memory.db"));
    const rows = store
      .getRecentForProject(resolveProjectIdentity(dir), 10)
      .filter((o) => o.type === "error");
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.source).toBe("auto-capture-failure");
    expect(rows[0].content).toContain("Cannot find module 'express'");
  }, 30_000);
});

/**
 * Pre-Mortem 1 trigger: a REAL failing `bun test` run, delivered as Claude
 * Code delivers it on failure (PostToolUseFailure, `error: "Exit code 1\n…"`),
 * must move TEST_WRITTEN → RED_CONFIRMED through the real dispatcher.
 */
describe("sentinal hook shared tdd-tracker on PostToolUseFailure (real bun test)", () => {
  let dir: string;
  let home: string;
  const impl = "/proj/src/widget.ts";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-hook-tdd-fail-")));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "widget.test.ts"),
      'import { it, expect } from "bun:test";\nit("renders", () => { expect(1).toBe(2); });\n',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves TEST_WRITTEN → RED_CONFIRMED from the failure's `error` text", () => {
    // Run a genuinely failing test (its own temp dir: no bunfig, no preload).
    const run = Bun.spawnSync(["bun", "test"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SENTINAL_HOME: home },
    });
    expect(run.exitCode).toBe(1);
    const error = `Exit code ${run.exitCode}\n${run.stdout.toString()}${run.stderr.toString()}`;

    const dbPath = join(home, "memory.db");
    let store = new MemoryStore(dbPath);
    store.setTddState({
      filePath: impl,
      state: "TEST_WRITTEN",
      projectPath: resolveProjectIdentity(dir),
    });
    store.close();

    const input = JSON.stringify({
      session_id: "test",
      transcript_path: "/tmp/t",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_use_id: "toolu_02",
      error,
      is_interrupt: false,
      duration_ms: 812,
    });
    const result = Bun.spawnSync(
      ["bun", CLI, "hook", "shared", "tdd-tracker"],
      {
        stdin: Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SENTINAL_HOME: home },
      },
    );
    expect(result.exitCode).toBe(0);

    store = new MemoryStore(dbPath);
    const row = store.getTddState(impl);
    store.close();
    expect(row?.state).toBe("RED_CONFIRMED");
  }, 60_000);
});
