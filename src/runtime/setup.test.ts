/**
 * `runWorktreeSetup` — the once-per-worktree `setup` command (orca D5).
 *
 * Real `sh -c` against temp directories: the commands are tiny shell snippets,
 * so the subprocess cost is milliseconds. Every test that spawns carries an
 * explicit budget anyway (sentinal-testing.md), and the timeout test shrinks
 * the runner's own timeout rather than raising the test's.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.js";
import {
  runWorktreeSetup,
  DEFAULT_SETUP_TIMEOUT_MS,
  type SetupSpawnOptions,
} from "./setup.js";
import { RUNTIME_LOG_RELATIVE_PATH, RUNTIME_LOG_TAIL_LINES } from "./schema.js";

let wt: string;
const logOf = () => readFileSync(join(wt, RUNTIME_LOG_RELATIVE_PATH), "utf-8");

beforeEach(() => {
  wt = realpathSync(makeTmpDir("sentinal-setup"));
});
afterEach(() => rmSync(wt, { recursive: true, force: true }));

describe("runWorktreeSetup — inert when nothing is declared", () => {
  it("defaults the timeout to 10 minutes", () => {
    expect(DEFAULT_SETUP_TIMEOUT_MS).toBe(600_000);
  });

  it("is ran:false, ok:true with no contract, and writes nothing", async () => {
    const r = await runWorktreeSetup(wt, null);
    expect(r).toEqual({
      ran: false,
      ok: true,
      exitCode: null,
      timedOut: false,
      tail: "",
    });
    expect(existsSync(join(wt, ".sentinal"))).toBe(false);
  });

  it("is ran:false, ok:true for a contract that declares no setup", async () => {
    const r = await runWorktreeSetup(wt, { setup: undefined });
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(existsSync(join(wt, RUNTIME_LOG_RELATIVE_PATH))).toBe(false);
  });
});

describe("runWorktreeSetup — running the command", () => {
  it("runs in the worktree via sh -c and reports success", async () => {
    const r = await runWorktreeSetup(wt, {
      setup: "echo hello-setup && pwd && touch made-here",
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.tail).toContain("hello-setup");
    expect(r.tail).toContain(wt);
    expect(existsSync(join(wt, "made-here"))).toBe(true);
  }, 10_000);

  it("reports a non-zero exit as a failure with stderr in the tail", async () => {
    const r = await runWorktreeSetup(wt, {
      setup: "echo boom-on-stderr >&2; exit 3",
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.tail).toContain("boom-on-stderr");
  }, 10_000);

  it("kills a command that outlives the timeout and reports timedOut", async () => {
    const started = Date.now();
    const r = await runWorktreeSetup(
      wt,
      // `exec` so the killed leader IS the sleeper — no orphan outlives the test.
      { setup: "echo before-sleep; exec sleep 20" },
      { timeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.tail).toContain("before-sleep");
    expect(logOf()).toContain("timed out");
  }, 10_000);

  it("runs a temp script file, as a project's setup would", async () => {
    const script = join(wt, "setup.sh");
    writeFileSync(script, "#!/bin/sh\necho from-script\nexit 0\n", {
      mode: 0o755,
    });
    const r = await runWorktreeSetup(wt, { setup: "./setup.sh" });
    expect(r.ok).toBe(true);
    expect(r.tail).toContain("from-script");
  }, 10_000);
});

describe("runWorktreeSetup — the runtime log", () => {
  it("appends a header naming the command, then the output", async () => {
    await runWorktreeSetup(wt, { setup: "echo logged-line" });
    const log = logOf();
    expect(log).toContain("setup");
    expect(log).toContain("`echo logged-line`");
    expect(log.indexOf("`echo logged-line`")).toBeLessThan(
      log.indexOf("logged-line\n"),
    );
  }, 10_000);

  it("appends — never truncates — an existing runtime log", async () => {
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
    writeFileSync(join(wt, RUNTIME_LOG_RELATIVE_PATH), "earlier-evidence\n");
    const r = await runWorktreeSetup(wt, { setup: "echo this-run" });
    expect(logOf().startsWith("earlier-evidence\n")).toBe(true);
    expect(logOf()).toContain("this-run");
    // The tail is THIS run's output, not a previous failure's.
    expect(r.tail).not.toContain("earlier-evidence");
  }, 10_000);

  it("caps the tail at RUNTIME_LOG_TAIL_LINES lines", async () => {
    const r = await runWorktreeSetup(wt, {
      setup: "i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done",
    });
    const lines = r.tail.split("\n");
    expect(lines.length).toBeLessThanOrEqual(RUNTIME_LOG_TAIL_LINES);
    expect(r.tail).toContain("line-199");
    expect(r.tail).not.toContain("line-0\n");
  }, 10_000);
});

describe("runWorktreeSetup — environment", () => {
  it("exports SENTINAL_WORKTREE_SLOT when a slot is given", async () => {
    const r = await runWorktreeSetup(
      wt,
      { setup: 'echo "slot=[$SENTINAL_WORKTREE_SLOT]"' },
      { slot: 7 },
    );
    expect(r.tail).toContain("slot=[7]");
  }, 10_000);

  it("never leaks an inherited slot when none is given", async () => {
    const prev = process.env.SENTINAL_WORKTREE_SLOT;
    process.env.SENTINAL_WORKTREE_SLOT = "99";
    try {
      const r = await runWorktreeSetup(wt, {
        setup: 'echo "slot=[$SENTINAL_WORKTREE_SLOT]"',
      });
      expect(r.tail).toContain("slot=[]");
    } finally {
      if (prev === undefined) delete process.env.SENTINAL_WORKTREE_SLOT;
      else process.env.SENTINAL_WORKTREE_SLOT = prev;
    }
  }, 10_000);
});

describe("runWorktreeSetup — never throws", () => {
  it("REFUSES a setup whose ${SENTINAL_*} token survived interpolation", async () => {
    const calls: SetupSpawnOptions[] = [];
    const r = await runWorktreeSetup(
      wt,
      { setup: "./deps --slot ${SENTINAL_WORKTREE_SLOT}" },
      {
        spawn: (o) => {
          calls.push(o);
          return { exited: Promise.resolve(0), kill: () => {} };
        },
      },
    );
    expect(calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("SENTINAL_WORKTREE_SLOT");
  });

  it("turns a spawn that throws into a failed result", async () => {
    const r = await runWorktreeSetup(
      wt,
      { setup: "echo x" },
      {
        spawn: () => {
          throw new Error("spawn exploded");
        },
      },
    );
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("spawn exploded");
  });

  it("turns a missing worktree directory into a failed result", async () => {
    const r = await runWorktreeSetup(join(wt, "does-not-exist"), {
      setup: "echo x",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  }, 10_000);

  it("passes the command, the worktree cwd and the log fd to an injected spawn", async () => {
    const calls: SetupSpawnOptions[] = [];
    const r = await runWorktreeSetup(
      wt,
      { setup: "make deps" },
      {
        spawn: (o) => {
          calls.push(o);
          return { exited: Promise.resolve(0), kill: () => {} };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("make deps");
    expect(calls[0]!.cwd).toBe(wt);
    expect(typeof calls[0]!.logFd).toBe("number");
  });
});
