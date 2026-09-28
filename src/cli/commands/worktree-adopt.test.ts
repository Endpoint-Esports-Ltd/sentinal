/**
 * `sentinal worktree ensure` (orca Task 9) — the CLI face of `worktree_ensure`,
 * driven in-process against REAL git repos with an injected temp DB (never the
 * developer's `~/.sentinal`).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { makeTmpDir } from "../../test-helpers.js";
import { MemoryStore } from "../../memory/store.js";
import { WorktreeStore } from "../../worktree/store.js";
import {
  DEFAULT_WORKTREE_CONFIG,
  type WorktreeConfig,
} from "../../worktree/types.js";
import { registerWorktreeAdoptCommands } from "./worktree-adopt.js";

const T = 30_000;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
}

describe("sentinal worktree ensure", () => {
  let tmp: string;
  let repo: string;
  let orca: string;
  let dbPath: string;
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  let config: WorktreeConfig;

  function program(): Command {
    const p = new Command();
    p.exitOverride();
    const wt = p.command("worktree");
    registerWorktreeAdoptCommands(wt, {
      openStore: () => new MemoryStore(dbPath),
      config: () => config,
    });
    return p;
  }

  async function run(args: string[]): Promise<void> {
    await program().parseAsync(["worktree", "ensure", ...args], {
      from: "user",
    });
  }

  function lastJson(): Record<string, unknown> {
    return JSON.parse(logs[logs.length - 1]!) as Record<string, unknown>;
  }

  function rows() {
    const store = new MemoryStore(dbPath);
    try {
      return new WorktreeStore(store).listAll();
    } finally {
      store.close();
    }
  }

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("sentinal-ensure-cli"));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# r\n");
    writeFileSync(join(repo, ".env.example"), "A=${SENTINAL_WORKTREE_SLOT}\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    git(["branch", "coord"], repo);
    orca = join(tmp, "orca-x");
    git(["worktree", "add", orca, "-b", "orca-x", "coord"], repo);
    mkdirSync(join(tmp, "db"));
    dbPath = join(tmp, "db", "test.db");
    config = DEFAULT_WORKTREE_CONFIG;
    logs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes every documented option", () => {
    const ensure = program().commands[0]!.commands.find(
      (c) => c.name() === "ensure",
    )!;
    const names = ensure.options.map((o) => o.long);
    for (const n of [
      "--path",
      "--base",
      "--owner",
      "--no-seed",
      "--takeover",
      "--project",
      "--json",
    ]) {
      expect(names).toContain(n);
    }
  });

  it(
    "--json adopts an external worktree and mirrors the tool's report",
    async () => {
      await run([
        "p1",
        "--project",
        repo,
        "--path",
        orca,
        "--base",
        "coord",
        "--owner",
        "external",
        "--json",
      ]);
      const out = lastJson();
      expect(out).toMatchObject({
        action: "adopted",
        path: orca,
        branch: "orca-x",
        base: "coord",
        owner: "external",
        slot: 1,
        setup: null,
      });
      expect(Array.isArray(out.warnings)).toBe(true);
      expect(rows()[0]!.owner).toBe("external");
      expect(existsSync(join(orca, ".env"))).toBe(true);
    },
    T,
  );

  it(
    "--owner external without --base is refused and records nothing",
    async () => {
      await run([
        "p1",
        "--project",
        repo,
        "--path",
        orca,
        "--owner",
        "external",
        "--json",
      ]);
      expect(String(lastJson().error)).toContain("base");
      expect(process.exitCode).toBe(1);
      expect(rows()).toEqual([]);
    },
    T,
  );

  it("rejects an unknown --owner", async () => {
    await run(["p1", "--project", repo, "--owner", "orca", "--json"]);
    expect(String(lastJson().error)).toContain("sentinal|external");
    expect(process.exitCode).toBe(1);
  });

  it(
    "--no-seed adopts without seeding",
    async () => {
      await run([
        "p1",
        "--project",
        repo,
        "--path",
        orca,
        "--base",
        "coord",
        "--owner",
        "external",
        "--no-seed",
        "--json",
      ]);
      expect(lastJson().action).toBe("adopted");
      expect(existsSync(join(orca, ".env"))).toBe(false);
    },
    T,
  );

  it(
    "runs the config's setup runner and prints the result in text mode",
    async () => {
      config = {
        ...DEFAULT_WORKTREE_CONFIG,
        runSetup: async () => ({
          ran: true,
          ok: true,
          exitCode: 0,
          timedOut: false,
          tail: "",
        }),
      };
      await run(["p-solo", "--project", repo]);
      const text = logs.join("\n");
      expect(text).toContain("Created: ");
      expect(text).toContain("Owner:  sentinal");
      expect(text).toContain("Setup:  ran, ok");
    },
    T,
  );

  it(
    "is registered on the real `sentinal worktree` command",
    () => {
      const r = Bun.spawnSync(
        ["bun", "run", "src/cli/index.ts", "worktree", "--help"],
        { cwd: resolve(import.meta.dir, "..", "..", "..") },
      );
      expect(r.stdout.toString()).toContain("ensure");
    },
    T,
  );
});
