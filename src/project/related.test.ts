import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadRelatedProjects, relatedJsonPath } from "./related.js";

let root: string;
let a: string;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function writeRelated(workspace: string, content: string): void {
  mkdirSync(join(workspace, ".sentinal"), { recursive: true });
  writeFileSync(relatedJsonPath(workspace), content);
}

/** Identity = the path itself; no git spawn in unit tests. */
const deps = { identity: (p: string) => p };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-related-")));
  a = join(root, "a");
  mkdirSync(a);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadRelatedProjects", () => {
  it("should return empty without warnings when the file is missing", () => {
    expect(loadRelatedProjects(a, deps)).toEqual({
      projects: [],
      warnings: [],
    });
  });

  it("should resolve relative and absolute paths, default names, and report rules", () => {
    const api = join(root, "api");
    const web = join(root, "web");
    mkdirSync(join(api, ".sentinal", "rules"), { recursive: true });
    writeFileSync(join(api, ".sentinal", "rules", "x.md"), "# x");
    mkdirSync(web);
    writeRelated(
      a,
      JSON.stringify({
        projects: [{ name: "api", path: "../api" }, { path: web }],
      }),
    );
    const { projects, warnings } = loadRelatedProjects(a, deps);
    expect(warnings).toEqual([]);
    expect(projects).toEqual([
      { name: "api", path: api, identity: api, exists: true, hasRules: true },
      {
        name: basename(web),
        path: web,
        identity: web,
        exists: true,
        hasRules: false,
      },
    ]);
  });

  it("should keep a non-existent path with exists: false", () => {
    writeRelated(a, JSON.stringify({ projects: [{ path: "../gone" }] }));
    const { projects } = loadRelatedProjects(a, deps);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.exists).toBe(false);
    expect(projects[0]!.hasRules).toBe(false);
    expect(projects[0]!.name).toBe("gone");
  });

  it("should warn and return empty on invalid JSON", () => {
    writeRelated(a, "{ not json");
    const r = loadRelatedProjects(a, deps);
    expect(r.projects).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("related.json");
  });

  it("should warn and return empty on a schema violation", () => {
    writeRelated(a, JSON.stringify({ projects: [{ name: 3 }] }));
    const r = loadRelatedProjects(a, deps);
    expect(r.projects).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("should drop entries whose identity is the declaring project's", () => {
    mkdirSync(join(root, "b"));
    writeRelated(
      a,
      JSON.stringify({ projects: [{ path: "." }, { path: "../b" }] }),
    );
    const { projects } = loadRelatedProjects(a, deps);
    expect(projects.map((p) => p.name)).toEqual(["b"]);
  });

  it("should never throw on bogus input or binary content", () => {
    expect(() => loadRelatedProjects("")).not.toThrow();
    expect(() => loadRelatedProjects("/nonexistent/x/y")).not.toThrow();
    writeRelated(a, Buffer.from([0, 255, 1, 2]).toString("latin1"));
    expect(loadRelatedProjects(a, deps).projects).toEqual([]);
    writeRelated(a, JSON.stringify({ projects: [{ path: "\u0000bad" }] }));
    expect(() => loadRelatedProjects(a, deps)).not.toThrow();
  });

  it("should upgrade a known-prior .sentinal/.gitignore so related.json is not ignored", () => {
    execFileSync("git", ["init", "-q"], { cwd: a, env: gitEnv });
    mkdirSync(join(a, ".sentinal"), { recursive: true });
    // v3 — the content Sentinal generated before related.json was allowlisted.
    const v3 =
      "# Ignore everything in .sentinal/ except shared project memory, the runtime\n" +
      "# contract, rules, and skills\n*\n!.gitignore\n!project-memory.json\n!runtime.json\n" +
      "!rules\n!rules/\n!rules/**\n!skills\n!skills/\n!skills/**\n";
    writeFileSync(join(a, ".sentinal", ".gitignore"), v3);
    writeRelated(a, JSON.stringify({ projects: [] }));

    const r = loadRelatedProjects(a, deps);
    expect(readFileSync(join(a, ".sentinal", ".gitignore"), "utf-8")).toContain(
      "!related.json",
    );
    expect(r.gitignored).toBe(false);
  });

  it("should report gitignored when a customised .gitignore still ignores it", () => {
    execFileSync("git", ["init", "-q"], { cwd: a, env: gitEnv });
    mkdirSync(join(a, ".sentinal"), { recursive: true });
    writeFileSync(join(a, ".sentinal", ".gitignore"), "*\n!.gitignore\n");
    writeRelated(a, JSON.stringify({ projects: [] }));

    const r = loadRelatedProjects(a, deps);
    expect(r.gitignored).toBe(true);
    expect(r.warnings.join("\n")).toContain("add `!related.json`");
  });
});
