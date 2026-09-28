/**
 * `worktree_ensure` (orca Task 9) — create-or-adopt as an MCP tool, driven
 * through `registerWorktreeTools` (the seam production uses) against REAL git
 * repos. The "Orca-style" worktree is a plain `git worktree add` on a branch
 * with no Sentinal prefix, outside `.sentinal/worktrees`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captureTools, makeTmpDir, type ToolHandler } from "../test-helpers.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { registerWorktreeTools } from "./mcp-tools.js";
import {
  ensureInputError,
  ensureReport,
  formatEnsureMarkdown,
  formatSetupLine,
  registerWorktreeEnsureTool,
} from "./adopt-mcp-tool.js";
import {
  DEFAULT_WORKTREE_CONFIG,
  NO_RUNTIME_STOP,
  NO_TOKEN_CHECK,
  type WorktreeConfig,
} from "./types.js";
import type { EnsuredWorktree } from "./adopt.js";

const T = 30_000;

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

const testConfig: WorktreeConfig = {
  enabled: true,
  directory: ".sentinal/worktrees",
  branchPrefix: "sentinal/spec-",
  maxActive: 3,
  autoCleanup: true,
  stopOwnedRuntime: NO_RUNTIME_STOP,
  unknownSentinalTokens: NO_TOKEN_CHECK,
};

describe("worktree_ensure MCP tool", () => {
  let tmp: string;
  let repo: string;
  let orca: string;
  let memoryStore: MemoryStore;
  let wtStore: WorktreeStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmp = realpathSync(makeTmpDir("sentinal-ensure-tool"));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# r\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    git(["branch", "coord"], repo);
    orca = join(tmp, "orca-x");
    git(["worktree", "add", orca, "-b", "orca-x", "coord"], repo);
    mkdirSync(join(tmp, "db"));
    memoryStore = new MemoryStore(join(tmp, "db", "test.db"));
    wtStore = new WorktreeStore(memoryStore);
    tools = captureTools(registerWorktreeTools, {
      store: memoryStore,
      worktreeConfig: testConfig,
    });
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is registered by registerWorktreeTools", () => {
    expect(tools.has("worktree_ensure")).toBe(true);
  });

  it("owner sentinal on an existing path needs takeover; with it the path is adopted", async () => {
    const refused = await tools.get("worktree_ensure")!({
      plan_slug: "tk",
      project: repo,
      path: orca,
    });
    expect(refused.content[0]!.text).toContain("takeover");
    const ok = await tools.get("worktree_ensure")!({
      plan_slug: "tk",
      project: repo,
      path: orca,
      takeover: true,
    });
    expect(ok.content[0]!.text).toContain("Adopted");
  }, 30_000);

  it(
    "owner external without base is refused clearly and records nothing",
    async () => {
      const r = await tools.get("worktree_ensure")!({
        plan_slug: "p1",
        project: repo,
        path: orca,
        owner: "external",
      });
      const text = r.content[0]!.text;
      expect(text).toMatch(/^Error ensuring worktree/);
      expect(text).toContain("base");
      expect(wtStore.listAll()).toEqual([]);
    },
    T,
  );

  it(
    "adopts an external worktree: owner, slug, base, slot recorded; dir untouched",
    async () => {
      const r = await tools.get("worktree_ensure")!({
        plan_slug: "2026-09-28-phase-1",
        project: repo,
        path: orca,
        base: "coord",
        owner: "external",
      });
      const text = r.content[0]!.text;
      expect(text).toContain("## Adopted Worktree");
      expect(text).toContain(`**Path:** ${orca}`);
      expect(text).toContain("**Branch:** orca-x");
      expect(text).toContain("**Base Branch:** coord");
      expect(text).toContain("**Owner:** external");
      expect(text).toContain("**Slot:**");
      const rows = wtStore.listAll();
      expect(rows.length).toBe(1);
      expect(rows[0]!.owner).toBe("external");
      expect(rows[0]!.worktreePath).toBe(orca);
      expect(existsSync(orca)).toBe(true);

      const again = await tools.get("worktree_ensure")!({
        plan_slug: "2026-09-28-phase-1",
        project: repo,
        path: orca,
        base: "coord",
        owner: "external",
      });
      expect(again.content[0]!.text).toContain("## Existing Worktree");
      expect(again.content[0]!.text).toContain(`**ID:** ${rows[0]!.id}`);
      expect(wtStore.listAll().length).toBe(1);
    },
    T,
  );

  it(
    "without a path it creates a Sentinal-owned worktree",
    async () => {
      const r = await tools.get("worktree_ensure")!({
        plan_slug: "2026-09-28-solo",
        project: repo,
      });
      const text = r.content[0]!.text;
      expect(text).toContain("## Created Worktree");
      expect(text).toContain("**Owner:** sentinal");
      expect(text).toContain("sentinal/spec-2026-09-28-solo");
    },
    T,
  );

  it(
    "runs the config's setup runner and surfaces a failure with its tail",
    async () => {
      const failing = captureTools(registerWorktreeTools, {
        store: memoryStore,
        worktreeConfig: {
          ...testConfig,
          runSetup: async () => ({
            ran: true,
            ok: false,
            exitCode: 3,
            timedOut: false,
            tail: "npm ERR! lockfile",
          }),
        },
      });
      const r = await failing.get("worktree_ensure")!({
        plan_slug: "p-setup",
        project: repo,
        path: orca,
        base: "coord",
        owner: "external",
      });
      const text = r.content[0]!.text;
      expect(text).toContain("**Setup:** ran, FAILED (exit 3)");
      expect(text).toContain("### Warnings");
      expect(text).toContain("npm ERR! lockfile");
      // A failed setup never undoes the adoption.
      expect(wtStore.listAll().length).toBe(1);
    },
    T,
  );

  it(
    "seed: false adopts without writing the seeded env file",
    async () => {
      writeFileSync(join(repo, ".env.example"), "A=1\n");
      git(["add", "."], repo);
      git(["commit", "-m", "env"], repo);
      git(["merge", "main"], orca);
      await tools.get("worktree_ensure")!({
        plan_slug: "p-noseed",
        project: repo,
        path: orca,
        base: "coord",
        owner: "external",
        seed: false,
      });
      expect(existsSync(join(orca, ".env"))).toBe(false);
    },
    T,
  );

  it("the description explains adoption and that external is never deleted", () => {
    let description = "";
    const server = {
      tool: (name: string, desc: string) => {
        if (name === "worktree_ensure") description = desc;
      },
    } as unknown as McpServer;
    registerWorktreeEnsureTool(server, wtStore, DEFAULT_WORKTREE_CONFIG);
    expect(description).toMatch(/adopt/i);
    expect(description).toMatch(/never (deleted|removed)/i);
  });
});

describe("worktree_ensure formatting helpers", () => {
  const base: EnsuredWorktree = {
    id: "p-1234",
    specId: null,
    projectPath: "/r",
    worktreePath: "/w",
    branchName: "orca-x",
    baseBranch: "coord",
    baseCommit: "abc",
    status: "active",
    createdAt: 0,
    slot: 2,
    owner: "external",
    slug: "p",
    created: false,
    adopted: true,
    existing: false,
  };

  it("ensureInputError requires path AND base for external", () => {
    expect(ensureInputError({ owner: "external" })).toContain("path");
    expect(ensureInputError({ owner: "external", path: "/w" })).toContain(
      "base",
    );
    expect(
      ensureInputError({ owner: "external", path: "/w", base: "b" }),
    ).toBeNull();
    expect(ensureInputError({})).toBeNull();
  });

  it("ensureReport is the machine-readable shape the CLI prints", () => {
    const r = ensureReport(base, ["w1"]);
    expect(r).toMatchObject({
      action: "adopted",
      id: "p-1234",
      path: "/w",
      branch: "orca-x",
      base: "coord",
      slot: 2,
      owner: "external",
      setup: null,
      warnings: ["w1"],
    });
    expect(String(r.slotNote)).toContain("2");
  });

  it("an absent owner reads as sentinal (pre-V15 rows)", () => {
    const { owner: _owner, ...legacy } = base;
    expect(ensureReport(legacy as EnsuredWorktree, []).owner).toBe("sentinal");
  });

  it("formatSetupLine distinguishes not-run, none-declared, ok and failed", () => {
    expect(formatSetupLine(undefined)).toContain("not run");
    expect(
      formatSetupLine({
        ran: false,
        ok: true,
        exitCode: null,
        timedOut: false,
        tail: "",
      }),
    ).toContain("none declared");
    expect(
      formatSetupLine({
        ran: true,
        ok: true,
        exitCode: 0,
        timedOut: false,
        tail: "",
      }),
    ).toContain("ran, ok");
    expect(
      formatSetupLine({
        ran: true,
        ok: false,
        exitCode: null,
        timedOut: true,
        tail: "",
      }),
    ).toContain("timed out");
  });

  it("formatEnsureMarkdown lists warnings last", () => {
    const md = formatEnsureMarkdown(ensureReport(base, ["careful"]));
    expect(md.startsWith("## Adopted Worktree")).toBe(true);
    expect(md.trimEnd().endsWith("- careful")).toBe(true);
  });
});
