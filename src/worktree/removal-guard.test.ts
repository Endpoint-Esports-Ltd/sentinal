/**
 * guardOrcaWorktreeRemoval — the veto behind `orca_remove_worktree` (spec
 * review must_fix). Real git fixtures; nothing is removed here.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { guardOrcaWorktreeRemoval } from "./removal-guard.js";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

describe("guardOrcaWorktreeRemoval", () => {
  let tmp: string;
  let main: string;
  let coord: string;
  let child: string;
  let memory: MemoryStore;
  let store: WorktreeStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "rm-guard-")));
    main = join(tmp, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(
      main,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    coord = join(tmp, "coord");
    child = join(tmp, "child");
    git(main, "worktree", "add", "-q", coord, "-b", "coord");
    git(main, "worktree", "add", "-q", child, "-b", "child");
    memory = new MemoryStore(":memory:");
    store = new WorktreeStore(memory);
  });

  afterEach(() => {
    memory.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const row = (status: "active" | "abandoned") =>
    store.insert({
      id: "wt-child",
      projectPath: main,
      worktreePath: child,
      branchName: "child",
      baseBranch: "coord",
      baseCommit: "abc",
      status,
      createdAt: Date.now(),
      owner: "external",
      slug: "child",
    });

  it("refuses the main checkout", async () => {
    const r = await guardOrcaWorktreeRemoval(main, { cwd: coord, store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("main checkout");
  }, 30_000);

  it("refuses the calling session's own checkout", async () => {
    const r = await guardOrcaWorktreeRemoval(coord, { cwd: coord, store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("this session");
  }, 30_000);

  it("refuses a worktree Sentinal still holds live, naming worktree_abandon", async () => {
    row("active");
    const r = await guardOrcaWorktreeRemoval(child, { cwd: coord, store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("worktree_abandon");
  }, 30_000);

  it("allows a released child worktree", async () => {
    row("abandoned");
    const r = await guardOrcaWorktreeRemoval(child, { cwd: coord, store });
    expect(r.ok).toBe(true);
  }, 30_000);

  it("refuses a path that is not a worktree of this repo", async () => {
    const r = await guardOrcaWorktreeRemoval(join(tmp, "elsewhere"), {
      cwd: coord,
      store,
    });
    expect(r.ok).toBe(false);
  }, 30_000);
});
