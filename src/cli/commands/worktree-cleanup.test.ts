/**
 * CLI parity for the destructive worktree commands (issue #9).
 *
 * The reporter's MCP call was failing, so they reached for the CLI as a
 * fallback — and found `sentinal worktree cleanup --force` rejected with
 * `error: unknown option '--force'`. The MCP tool exposes `force`; the CLI did
 * not, so there WAS no fallback. They also found `worktree_abandon` could not
 * see an orphan left by a crashed session ("No active worktree found for
 * slug"), leaving plain `git worktree remove --force` as the only route.
 *
 * ⛔ Adding `--force` is only safe if the guards get their inputs. The old CLI
 * called `manager.cleanup()` with NO options whatsoever, so `projectPath`,
 * `currentWorktree` and `isPlanActive` were all absent. Wiring `--force`
 * without them would be strictly MORE dangerous than the bug being fixed:
 * guard 5 fails closed and refuses, and guards 3/4 have nothing to test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { makeTmpDir } from "../../test-helpers.js";
import { registerWorktreeCleanupCommands } from "./worktree-cleanup.js";

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: dir });
}

/** Build a parser exposing only the cleanup/abandon commands. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit in tests
  const wt = program.command("worktree");
  registerWorktreeCleanupCommands(wt);
  return program;
}

describe("sentinal worktree cleanup — CLI parity", () => {
  let tmpDir: string;
  let repoDir: string;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts --force (the option whose absence blocked the fallback)", () => {
    const program = buildProgram();
    const cleanup = program.commands[0]!.commands.find(
      (c) => c.name() === "cleanup",
    )!;
    const names = cleanup.options.map((o) => o.long);
    expect(names).toContain("--force");
  });

  it("accepts --project and --current-worktree so the guards have inputs", () => {
    const program = buildProgram();
    const cleanup = program.commands[0]!.commands.find(
      (c) => c.name() === "cleanup",
    )!;
    const names = cleanup.options.map((o) => o.long);
    // ⛔ Without these, guard 3 (never the caller's worktree) and the project
    // scope have no values, and --force becomes indiscriminate.
    expect(names).toContain("--project");
    expect(names).toContain("--current-worktree");
  });

  it("owns every destructive worktree command — cleanup, abandon, abandon-orphan", () => {
    // Cohesion, not merely line count: this module is where the guard-wiring
    // rationale lives, so the commands that DELETE belong together. A
    // destructive command left behind in worktree.ts would not inherit it.
    const program = buildProgram();
    const names = program.commands[0]!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["abandon", "abandon-orphan", "cleanup"]);
  });

  it("reports what it removed, not just a count", async () => {
    const program = buildProgram();
    await program.parseAsync(["worktree", "cleanup", "--project", repoDir], {
      from: "user",
    });
    expect(logs.join("\n")).toMatch(/Cleaned up \d+ stale worktree/);
  });
});

describe("sentinal worktree abandon — reaching orphans", () => {
  let tmpDir: string;
  let repoDir: string;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes an on-disk orphan that has NO database record", async () => {
    // Exactly the state a crashed session leaves: a real git worktree on a
    // sentinal branch, with nothing in the DB pointing at it.
    const orphan = join(repoDir, ".sentinal", "worktrees", "spec-crashed");
    mkdirSync(join(repoDir, ".sentinal", "worktrees"), { recursive: true });
    Bun.spawnSync(
      ["git", "worktree", "add", "-b", "sentinal/spec-crashed", orphan],
      { cwd: repoDir },
    );
    expect(existsSync(orphan)).toBe(true);

    const program = buildProgram();
    await program.parseAsync(
      ["worktree", "abandon-orphan", "crashed", "--project", repoDir],
      { from: "user" },
    );

    // The whole point: reachable by a sentinal command, not only by
    // `git worktree remove --force`.
    expect(existsSync(orphan)).toBe(false);
  }, 30_000);

  it("says so plainly when there is no such orphan", async () => {
    const program = buildProgram();
    await program.parseAsync(
      ["worktree", "abandon-orphan", "does-not-exist", "--project", repoDir],
      { from: "user" },
    );
    expect(logs.join("\n")).toMatch(/no orphan|not found/i);
  });
});
