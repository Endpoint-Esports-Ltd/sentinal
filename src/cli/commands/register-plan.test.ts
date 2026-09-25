/**
 * register-plan — the stored `specs.project_path` must be the CANONICAL
 * identity (Task 10, #5/#10a). A raw subdirectory / symlink / `/var` alias key
 * made the Stop guard read the plan as ownerless → "orphaned" block.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { makeTmpDir } from "../../test-helpers.js";
import { MemoryStore } from "../../memory/store.js";
import { registerRegisterPlanCommand } from "./register-plan.js";

describe("sentinal register-plan — canonical project key", () => {
  let tmpDir: string;
  let repo: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir("register-plan"); // raw `/var/…` on macOS
    repo = join(tmpDir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
    mkdirSync(join(tmpDir, "home"));
    savedHome = process.env.SENTINAL_HOME;
    process.env.SENTINAL_HOME = join(tmpDir, "home");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SENTINAL_HOME;
    else process.env.SENTINAL_HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores the canonical root when --project is a raw subdirectory alias", async () => {
    const plan = join(repo, "docs", "plans", "2026-09-25-reg.md");
    writeFileSync(plan, "# Reg\n\nStatus: IN_PROGRESS\nType: Feature\n");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerRegisterPlanCommand(program);
      await program.parseAsync([
        "node",
        "sentinal",
        "register-plan",
        plan,
        "--project",
        join(repo, "src"),
        "--json",
      ]);
    } finally {
      log.mockRestore();
    }
    const store = new MemoryStore(join(tmpDir, "home", "memory.db"));
    try {
      const row = store
        .getRawDb()
        .prepare("SELECT project_path FROM specs WHERE slug = ?")
        .get("2026-09-25-reg") as { project_path: string } | null;
      expect(row?.project_path).toBe(realpathSync(repo));
    } finally {
      store.close();
    }
  }, 30_000);
});
