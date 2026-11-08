import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrcaRunner, OrcaRunOutput } from "./cli.js";
import { prepareChildWorktree } from "./dispatch-worktree.js";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): any => JSON.parse(fixture(name));

const out = (stdout: string, exitCode = 0): OrcaRunOutput => ({
  exitCode,
  stdout,
  stderr: "",
});
const ok = (result: unknown): OrcaRunOutput =>
  out(JSON.stringify({ id: "x", ok: true, result }));

/** Strictly ordered fake; never spawns the real `orca`. */
function queue(steps: Array<[string, OrcaRunOutput]>) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (args) => {
    calls.push(args);
    const next = steps.shift();
    const line = args.join(" ");
    if (!next || !line.startsWith(next[0])) {
      throw new Error(`unexpected orca call: ${line} (wanted ${next?.[0]})`);
    }
    return next[1];
  };
  return { runner, calls };
}

// A real directory reached through a symlinked tmpdir on macOS (/var → /private/var).
const scratch = mkdtempSync(join(tmpdir(), "sentinal-foreign-repo-"));
const repoB = join(scratch, "repoB");
mkdirSync(repoB);
const realB = realpathSync(repoB);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Recorded live (Orca 1.4.253): the probe repo B and its worktree.
const created = json("worktree-create-foreign-repo.json");
const recordedWt = created.result.worktree;

describe("prepareChildWorktree — foreign repo", () => {
  it("should pass --repo path:<realpath> and --no-parent, never --parent-worktree, when repo is given", async () => {
    const { runner, calls } = queue([
      ["worktree create", out(fixture("worktree-create-foreign-repo.json"))],
    ]);
    const r = await prepareChildWorktree({
      name: "sentinal-repo-probe",
      baseBranch: "main",
      repo: repoB,
      runner,
    });
    expect(r).toEqual({
      ok: true,
      path: recordedWt.path,
      worktreeId: recordedWt.id,
      branch: recordedWt.branch,
    });
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(["worktree", "create"]);
    expect(args[args.indexOf("--repo") + 1]).toBe(`path:${realB}`);
    expect(args).toContain("--no-parent");
    expect(args).not.toContain("--parent-worktree");
    expect(args[args.indexOf("--setup") + 1]).toBe("skip");
    expect(args[args.indexOf("--base-branch") + 1]).toBe("main");
    expect(args[args.indexOf("--name") + 1]).toBe("sentinal-repo-probe");
  });

  it("should name `orca repo add --path <repo>` when Orca does not know the repo", async () => {
    const { runner } = queue([
      [
        "worktree create",
        out(fixture("worktree-create-unregistered-repo.json"), 1),
      ],
    ]);
    const r = await prepareChildWorktree({
      name: "x",
      baseBranch: "main",
      repo: repoB,
      runner,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("repo_not_registered");
    expect(r.error.message).toContain(`orca repo add --path ${realB}`);
  });

  it("should refuse a repo path that does not exist without calling Orca", async () => {
    const { runner, calls } = queue([]);
    const r = await prepareChildWorktree({
      name: "x",
      baseBranch: "main",
      repo: join(scratch, "missing"),
      runner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_repo");
    expect(calls).toHaveLength(0);
  });

  it("should resolve a path-less create through the repo id and worktree list, never a bare name lookup", async () => {
    const repoShow = json("repo-show.json");
    repoShow.result.repo.path = realB;
    const { runner, calls } = queue([
      ["worktree create", ok({ created: true })],
      [`repo show --repo path:${realB}`, out(JSON.stringify(repoShow))],
      ["worktree list", out(fixture("worktree-list-foreign-repos.json"))],
    ]);
    const r = await prepareChildWorktree({
      name: "sentinal-repo-probe",
      baseBranch: "main",
      repo: repoB,
      runner,
    });
    // The list holds a same-named worktree in repo A too; repo B's id picks B's.
    expect(r).toMatchObject({ ok: true, path: recordedWt.path });
    expect(calls.map((c) => c.join(" ")).join("\n")).not.toContain(
      "worktree show",
    );
  });

  it("should fail when no listed worktree of that repo has the name", async () => {
    const { runner } = queue([
      ["worktree create", ok({})],
      ["repo show", out(fixture("repo-show.json"))],
      ["worktree list", out(fixture("worktree-list-foreign-repos.json"))],
    ]);
    const r = await prepareChildWorktree({
      name: "no-such-worktree",
      baseBranch: "main",
      repo: repoB,
      runner,
    });
    expect(r.ok).toBe(false);
  });

  it("should keep the same-repo argv unchanged when repo is absent", async () => {
    const { runner, calls } = queue([
      ["worktree create", ok({ worktree: { id: "r::/wt/a", path: "/wt/a" } })],
    ]);
    await prepareChildWorktree({ name: "a", baseBranch: "main", runner });
    expect(calls[0]).toEqual([
      "worktree",
      "create",
      "--name",
      "a",
      "--base-branch",
      "main",
      "--parent-worktree",
      "current",
      "--setup",
      "skip",
      "--json",
    ]);
  });
});
