import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOREIGN_RULES_MAX_CHARS,
  FOREIGN_RULES_TOTAL_CHARS,
  formatForeignRules,
  globToRegExp,
  parseRuleFile,
  readProjectRules,
  rulesForFile,
  type RuleFile,
} from "./foreign-rules.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinal-foreign-rules-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRule(name: string, content: string): string {
  const rulesDir = join(dir, ".sentinal", "rules");
  mkdirSync(rulesDir, { recursive: true });
  const p = join(rulesDir, name);
  writeFileSync(p, content);
  return p;
}

describe("constants", () => {
  it("should cap at 12k per project and 24k total", () => {
    expect(FOREIGN_RULES_MAX_CHARS).toBe(12_000);
    expect(FOREIGN_RULES_TOTAL_CHARS).toBe(24_000);
  });
});

describe("globToRegExp", () => {
  it("should match ** across directories, * within a segment, ? one char", () => {
    expect(globToRegExp("**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(globToRegExp("a?.md").test("a/.md")).toBe(false);
    expect(globToRegExp("src/**").test("src/x/y/z.ts")).toBe(true);
  });

  it("should escape regex metacharacters", () => {
    expect(globToRegExp("a.b+(c)").test("a.b+(c)")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("parseRuleFile", () => {
  it("should parse a paths: list with quoted and unquoted globs and strip frontmatter", () => {
    const r = parseRuleFile(
      "/x/a.md",
      `---\npaths:\n  - "**/*.component.ts"\n  - '**/*.pipe.ts'\n  - src/**\nother: 1\n---\n# Angular\nbody\n`,
    );
    expect(r.paths).toEqual(["**/*.component.ts", "**/*.pipe.ts", "src/**"]);
    expect(r.body).toBe("# Angular\nbody\n");
    expect(r.name).toBe("a.md");
  });

  it("should leave paths undefined without frontmatter", () => {
    const r = parseRuleFile("/x/b.md", "# B\ntext");
    expect(r.paths).toBeUndefined();
    expect(r.body).toBe("# B\ntext");
  });

  it("should strip frontmatter without a paths key", () => {
    const r = parseRuleFile("/x/c.md", "---\ntitle: x\n---\nbody");
    expect(r.paths).toBeUndefined();
    expect(r.body).toBe("body");
  });

  it("should keep an unterminated frontmatter as body", () => {
    const r = parseRuleFile("/x/d.md", "---\npaths:\n  - a\nno end");
    expect(r.paths).toBeUndefined();
    expect(r.body).toContain("no end");
  });
});

describe("readProjectRules", () => {
  it("should read *.md files sorted by name", () => {
    writeRule("b.md", "# B");
    writeRule("a.md", "# A");
    writeRule("notes.txt", "ignored");
    const rules = readProjectRules(dir);
    expect(rules.map((r) => r.name)).toEqual(["a.md", "b.md"]);
    expect(rules[0]!.path).toBe(join(dir, ".sentinal", "rules", "a.md"));
  });

  it("should return [] when there is no rules directory", () => {
    expect(readProjectRules(dir)).toEqual([]);
    expect(readProjectRules(join(dir, "nope"))).toEqual([]);
  });

  it("should never throw on bogus input, binary or huge files", () => {
    expect(() => readProjectRules("")).not.toThrow();
    writeRule("bin.md", Buffer.from([0, 1, 2, 255, 254]).toString("latin1"));
    writeRule("huge.md", "x".repeat(2_000_000));
    // A directory named like a rule file.
    mkdirSync(join(dir, ".sentinal", "rules", "dir.md"));
    const rules = readProjectRules(dir);
    expect(rules.map((r) => r.name)).toEqual(["bin.md", "huge.md"]);
    expect(rules[1]!.body.length).toBeLessThanOrEqual(200_000);
  });
});

describe("rulesForFile", () => {
  const rule = (name: string, paths?: string[]): RuleFile => ({
    path: `/w/.sentinal/rules/${name}`,
    name,
    paths,
    body: `# ${name}`,
  });

  it("should keep rules without paths and filter rules with paths", () => {
    const rules = [rule("all.md"), rule("ng.md", ["**/*.component.ts"])];
    expect(
      rulesForFile(rules, "src/app/x.component.ts").map((r) => r.name),
    ).toEqual(["all.md", "ng.md"]);
    expect(rulesForFile(rules, "src/main.ts").map((r) => r.name)).toEqual([
      "all.md",
    ]);
  });

  it("should normalise backslashes and a leading ./", () => {
    const rules = [rule("ng.md", ["src/*.ts"])];
    expect(rulesForFile(rules, "./src/a.ts")).toHaveLength(1);
    expect(rulesForFile(rules, "src\\a.ts")).toHaveLength(1);
  });
});

describe("formatForeignRules", () => {
  const mk = (name: string, body: string): RuleFile => ({
    path: `/repo/b/.sentinal/rules/${name}`,
    name,
    body,
  });

  it("should return an empty string when there are no rules", () => {
    expect(
      formatForeignRules({
        projectName: "b",
        workspace: "/repo/b",
        rules: [],
        maxChars: 100,
      }),
    ).toBe("");
  });

  it("should include a header and every body that fits", () => {
    const out = formatForeignRules({
      projectName: "b",
      workspace: "/repo/b",
      rules: [mk("a.md", "# Alpha\nrule a"), mk("c.md", "# Gamma\nrule c")],
      maxChars: 12_000,
    });
    expect(out).toContain(
      "[Sentinal] Rules for b (/repo/b) — you are editing files in this project:",
    );
    expect(out).toContain("rule a");
    expect(out).toContain("rule c");
    expect(out).not.toContain("Read these files before editing further");
  });

  it("should turn the overflow into a pointer list with first headings", () => {
    const out = formatForeignRules({
      projectName: "b",
      workspace: "/repo/b",
      rules: [
        mk("a.md", "# Alpha\n" + "a".repeat(300)),
        mk("c.md", "# Gamma\n" + "c".repeat(300)),
        mk("d.md", "no heading"),
      ],
      maxChars: 500,
    });
    expect(out).toContain("a".repeat(300));
    expect(out).not.toContain("c".repeat(300));
    expect(out).toContain("Read these files before editing further");
    expect(out).toContain("- /repo/b/.sentinal/rules/c.md — Gamma");
    expect(out).toContain("- /repo/b/.sentinal/rules/d.md — d.md");
  });

  it("should degrade to a pointer list when maxChars is 0", () => {
    const out = formatForeignRules({
      projectName: "b",
      workspace: "/repo/b",
      rules: [mk("a.md", "# Alpha\nx")],
      maxChars: 0,
    });
    expect(out).toContain("- /repo/b/.sentinal/rules/a.md — Alpha");
    expect(out).not.toContain("\nx\n");
  });
});
