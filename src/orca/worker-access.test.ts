/**
 * Prompt-free, read-only access for pre-warmed OpenCode workers
 * (docs/plans/2026-10-01-orca-worker-access.md). Pure — no orca/opencode.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_AGENTS,
  opencodeLaunch,
  workerAllowDirs,
} from "./worker-access.js";

/** Undo POSIX single quoting of `env OPENCODE_CONFIG_CONTENT='…' opencode`. */
function configOf(command: string): any {
  const m = /^env OPENCODE_CONFIG_CONTENT='((?:[^']|'\\'')*)' opencode$/.exec(
    command,
  );
  if (!m) throw new Error(`unexpected command: ${command}`);
  return JSON.parse(m[1]!.replaceAll("'\\''", "'"));
}

const base = { agent: "opencode", env: {}, platform: "darwin" as const };

describe("workerAllowDirs", () => {
  it("returns the defaults plus absolute extras, expanding ~, deduping, ignoring relative/empty", () => {
    expect(
      workerAllowDirs(
        { SENTINAL_ORCA_WORKER_ALLOW_DIRS: " ~/x/ , rel/dir, ,/abs/y,/r " },
        ["/r", "/c/co"],
        "/home/u",
      ),
    ).toEqual(["/r", "/c/co", "/home/u/x", "/abs/y"]);
  });

  it("is null when turned off", () => {
    expect(
      workerAllowDirs(
        { SENTINAL_ORCA_WORKER_ALLOW_DIRS: "none" },
        ["/r"],
        "/h",
      ),
    ).toBeNull();
  });
});

describe("opencodeLaunch", () => {
  it("allows the dirs without a prompt and denies edits there for every built-in agent (Truth 1)", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/r/.orca/worktrees/w",
      dirs: ["/r", "/c/co"],
      realpath: (p) => p,
    });
    expect(r.command.startsWith("env OPENCODE_CONFIG_CONTENT='")).toBe(true);
    const c = configOf(r.command);
    expect(c.permission.external_directory).toEqual({
      "/r/**": "allow",
      "/c/co/**": "allow",
    });
    expect(c.permission.edit["../../../*"]).toBe("deny");
    expect(c.permission.edit["../../../../c/co/*"]).toBe("deny");
    expect(WORKER_AGENTS).toContain("spec-task");
    for (const a of WORKER_AGENTS) {
      expect(c.agent[a].permission.edit["../../../*"]).toBe("deny");
    }
    expect(r.access).toEqual({ dirs: ["/r", "/c/co"], readOnly: true });
  });

  it("emits no rule for the worktree itself or a directory inside it (Truth 2)", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/co",
      dirs: ["/co", "/co/sub", "/r"],
      realpath: (p) => p,
    });
    const c = configOf(r.command);
    expect(Object.keys(c.permission.external_directory)).toEqual(["/r/**"]);
    expect(Object.keys(c.permission.edit)).toEqual(["../r/*"]);
    expect(r.access?.dirs).toEqual(["/r"]);
  });

  it("placement current: the coordinator checkout is the worktree, so only the main checkout remains", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/w/orca-support",
      dirs: ["/w/orca-support", "/p/sentinal"],
      realpath: (p) => p,
    });
    expect(r.access?.dirs).toEqual(["/p/sentinal"]);
  });

  it("plain command for another agent, Windows, no dirs, or only skipped dirs", () => {
    const w = { worktree: "/r/w", realpath: (p: string) => p };
    expect(
      opencodeLaunch({ ...base, ...w, agent: "claude", dirs: ["/r"] }).command,
    ).toBe("claude");
    expect(
      opencodeLaunch({ ...base, ...w, platform: "win32", dirs: ["/r"] })
        .command,
    ).toBe("opencode");
    expect(opencodeLaunch({ ...base, ...w, dirs: null }).command).toBe(
      "opencode",
    );
    expect(opencodeLaunch({ ...base, ...w, dirs: ["/r/w"] }).command).toBe(
      "opencode",
    );
  });

  it("quotes paths containing ' $ and ! safely", () => {
    const odd = "/p/it's $HOME!";
    const r = opencodeLaunch({
      ...base,
      worktree: "/w",
      dirs: [odd],
      realpath: (p) => p,
    });
    expect(configOf(r.command).permission.external_directory).toEqual({
      [`${odd}/**`]: "allow",
    });
    expect(r.command).not.toContain("\n");
  });

  it("skips (and reports) a directory with glob characters", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/w",
      dirs: ["/p/a*b", "/r"],
      realpath: (p) => p,
    });
    expect(r.access?.dirs).toEqual(["/r"]);
    expect(r.skippedDirs).toEqual(["/p/a*b"]);
  });

  it("merges into an existing JSON OPENCODE_CONFIG_CONTENT, wrapping a string edit rule", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/r/w",
      dirs: ["/r"],
      realpath: (p) => p,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "x/y",
          permission: { edit: "allow", bash: "ask" },
        }),
      },
    });
    const c = configOf(r.command);
    expect(c.model).toBe("x/y");
    expect(c.permission.bash).toBe("ask");
    expect(c.permission.edit).toEqual({ "*": "allow", "../*": "deny" });
  });

  it("skips (plain command) when the existing variable is not a JSON object", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/r/w",
      dirs: ["/r"],
      realpath: (p) => p,
      env: { OPENCODE_CONFIG_CONTENT: "not json" },
    });
    expect(r.command).toBe("opencode");
    expect(r.skipped).toContain("OPENCODE_CONFIG_CONTENT");
  });

  it("resolves symlinks before computing relative patterns (/var vs /private/var)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-")));
    const real = join(root, "real");
    mkdirSync(join(real, "wt"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    const r = opencodeLaunch({
      ...base,
      worktree: join(real, "wt"),
      dirs: [link],
    });
    expect(Object.keys(configOf(r.command).permission.edit)).toEqual(["../*"]);
  });
});

describe("opencodeLaunch — review fixes", () => {
  it("treats a directory named like ..cache inside the worktree as the worker's own", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/w",
      dirs: ["/w/..cache", "/r"],
      realpath: (p) => p,
    });
    expect(r.access?.dirs).toEqual(["/r"]);
  });

  it("checks glob characters on the resolved path (symlink target)", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/w",
      dirs: ["/link", "/r"],
      realpath: (p) => (p === "/link" ? "/real/a*b" : p),
    });
    expect(r.skippedDirs).toEqual(["/link"]);
    expect(r.access?.dirs).toEqual(["/r"]);
  });

  it("keeps a string permission (top level and per agent) as a catch-all rule", () => {
    const r = opencodeLaunch({
      ...base,
      worktree: "/r/w",
      dirs: ["/r"],
      realpath: (p) => p,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: "ask",
          agent: { build: { permission: "allow", model: "m" } },
        }),
      },
    });
    const c = configOf(r.command);
    expect(c.permission["*"]).toBe("ask");
    expect(c.permission.edit).toEqual({ "../*": "deny" });
    expect(c.agent.build.model).toBe("m");
    expect(c.agent.build.permission["*"]).toBe("allow");
    expect(c.agent.build.permission.edit).toEqual({ "../*": "deny" });
  });
});
