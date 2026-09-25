/**
 * Quality Lint Runner Tests — D1 of docs/plans/2026-09-24-hardening-sweep.md.
 *
 * `quality_report` must never rewrite a file it was not asked about:
 * project-wide is report-only, and only an explicit `file` inside the project
 * is fixed. Every test drives FAKE binaries and asserts their exact argv.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { runEslint, runPrettier } from "./quality-lint.js";
import { resolveQualityTarget } from "./quality-runners.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";

// ─── Fake eslint/prettier (argv-recording) ──────────────────────────────
//
// NEVER run the real formatter/linter here: project-wide `prettier --write .`
// is exactly the bug under test. Each fake appends its argv (one invocation
// per line) to `.fake/<tool>.argv`; behaviour per first flag (`--check`,
// `--write`, `--list-different`, `--format`, `--fix`) comes from
// `.fake/<tool>.<mode>.{out,err,exit,touch}`.

const FAKE_SCRIPT = (dir: string, tool: string) => `#!/bin/sh
D="${dir}/.fake"
printf '%s\\n' "$*" >> "$D/${tool}.argv"
M=$(echo "$1" | sed 's/^--//')
[ -f "$D/${tool}.$M.out" ] && cat "$D/${tool}.$M.out"
[ -f "$D/${tool}.$M.err" ] && cat "$D/${tool}.$M.err" >&2
[ -f "$D/${tool}.$M.touch" ] && echo "// fixed" >> "$2"
exit $(cat "$D/${tool}.$M.exit" 2>/dev/null || echo 0)
`;

type FakeSpec = Record<string, string | number | true>; // "prettier.check.exit" → 1

function makeFakeProject(spec: FakeSpec = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "qr-fake-")));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, ".fake"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const tool of ["eslint", "prettier"]) {
    writeFileSync(
      join(dir, "node_modules", ".bin", tool),
      FAKE_SCRIPT(dir, tool),
      {
        mode: 0o755,
      },
    );
  }
  for (const [k, v] of Object.entries(spec)) {
    writeFileSync(join(dir, ".fake", k), v === true ? "" : String(v));
  }
  return dir;
}

function argvOf(dir: string, tool: string): string[] {
  const p = join(dir, ".fake", `${tool}.argv`);
  return existsSync(p)
    ? readFileSync(p, "utf-8").split("\n").filter(Boolean)
    : [];
}

const fakeDirs: string[] = [];
function fake(spec?: FakeSpec): string {
  const d = makeFakeProject(spec);
  fakeDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of fakeDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

// ─── D1: project-wide is report-only ─────────────────────────────────────

describe("runPrettier — project-wide (no file) is report-only", () => {
  it("runs `--list-different .` only — never --write — and lists the first 20 files + total", async () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const dir = fake({
      "prettier.list-different.out": files.join("\n") + "\n",
      "prettier.list-different.exit": 1,
    });
    const r = await runPrettier(dir, undefined, 5_000);
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
    expect(r.ok).toBe(false);
    expect(r.fixMode).toBe("none");
    expect(r.autoFixed).toBe(false);
    expect(r.fileCount).toBe(25);
    expect(r.files).toEqual(files.slice(0, 20));
  }, 10_000);

  it("reports a tool error (exit 2) without listing files or writing", async () => {
    const dir = fake({
      "prettier.list-different.err": "[error] Invalid configuration\n",
      "prettier.list-different.exit": 2,
    });
    const r = await runPrettier(dir, undefined, 5_000);
    expect(argvOf(dir, "prettier")).toEqual(["--list-different ."]);
    expect(r.ok).toBe(false);
    expect(r.autoFixed).toBe(false);
    expect(r.fileCount).toBeUndefined();
    expect(r.errors.join("\n")).toContain("Invalid configuration");
  }, 10_000);

  it("is ok with fileCount 0 when everything is formatted", async () => {
    const dir = fake();
    const r = await runPrettier(dir, undefined, 5_000);
    expect(r.ok).toBe(true);
    expect(r.fileCount).toBe(0);
    expect(r.files).toEqual([]);
  }, 10_000);
});

describe("runPrettier — single file", () => {
  it("checks, then writes ONLY the given file when check exits 1", async () => {
    const dir = fake({ "prettier.check.exit": 1 });
    const abs = join(dir, "src", "a.ts");
    const r = await runPrettier(dir, abs, 5_000);
    expect(argvOf(dir, "prettier")).toEqual([
      `--check ${abs}`,
      `--write ${abs}`,
    ]);
    expect(r.ok).toBe(true);
    expect(r.autoFixed).toBe(true);
    expect(r.fixMode).toBe("file");
  }, 10_000);

  it("never writes when --check exits 2 (tool error) and does not report autoFixed", async () => {
    const dir = fake({
      "prettier.check.exit": 2,
      "prettier.check.err": "[error] src/a.ts: SyntaxError\n",
    });
    const abs = join(dir, "src", "a.ts");
    const r = await runPrettier(dir, abs, 5_000);
    expect(argvOf(dir, "prettier")).toEqual([`--check ${abs}`]);
    expect(r.ok).toBe(false);
    expect(r.autoFixed).toBe(false);
    expect(r.errors.join("\n")).toContain("SyntaxError");
  }, 10_000);

  it("honours a failing --write exit code", async () => {
    const dir = fake({
      "prettier.check.exit": 1,
      "prettier.write.exit": 2,
      "prettier.write.err": "[error] EACCES\n",
    });
    const r = await runPrettier(dir, join(dir, "src", "a.ts"), 5_000);
    expect(r.ok).toBe(false);
    expect(r.autoFixed).toBe(false);
    expect(r.errors.join("\n")).toContain("EACCES");
  }, 10_000);

  it("resolves a relative file against the project, not the process cwd", async () => {
    const dir = fake({ "prettier.check.exit": 1 });
    await runPrettier(dir, "src/a.ts", 5_000);
    expect(argvOf(dir, "prettier")).toEqual([
      `--check ${join(dir, "src", "a.ts")}`,
      `--write ${join(dir, "src", "a.ts")}`,
    ]);
  }, 10_000);
});

const ESLINT_JSON = (dir: string) =>
  JSON.stringify([
    {
      filePath: join(dir, "src", "a.ts"),
      errorCount: 2,
      warningCount: 1,
      messages: [
        { ruleId: "no-unused-vars", severity: 2, line: 3, message: "x" },
        { ruleId: "no-unused-vars", severity: 2, line: 9, message: "y" },
        { ruleId: "prefer-const", severity: 1, line: 4, message: "z" },
      ],
    },
    {
      filePath: join(dir, "src", "b.ts"),
      errorCount: 1,
      warningCount: 0,
      messages: [
        { ruleId: null, severity: 2, line: 1, message: "Parsing error" },
      ],
    },
    {
      filePath: join(dir, "src", "c.ts"),
      errorCount: 0,
      warningCount: 0,
      messages: [],
    },
  ]);

describe("runEslint — project-wide (no file) is report-only", () => {
  it("runs `--format json .` — never --fix — and reports real totals, top rules and locations", async () => {
    const dir = fake({ "eslint.format.exit": 1 });
    writeFileSync(join(dir, ".fake", "eslint.format.out"), ESLINT_JSON(dir));
    const r = await runEslint(dir, undefined, 5_000);
    expect(argvOf(dir, "eslint")).toEqual(["--format json ."]);
    expect(r.ok).toBe(false);
    expect(r.fixMode).toBe("none");
    expect(r.autoFixed).toBe(false);
    expect(r.errorCount).toBe(3);
    expect(r.warningCount).toBe(1);
    expect(r.topRules?.[0]).toEqual({ rule: "no-unused-vars", count: 2 });
    expect(r.errors).toContain("src/a.ts:3 no-unused-vars");
    expect(r.errors).toContain("src/b.ts:1 Parsing error");
  }, 10_000);

  it("reports a crash (exit 2, non-JSON) as not ok with stderr", async () => {
    const dir = fake({
      "eslint.format.exit": 2,
      "eslint.format.err": "Oops! Something went wrong! No config\n",
    });
    const r = await runEslint(dir, undefined, 5_000);
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBeUndefined();
    expect(r.errors.join("\n")).toContain("No config");
  }, 10_000);
});

describe("runEslint — single file", () => {
  it("runs --fix on the resolved file and detects the fix via its mtime (relative path)", async () => {
    const dir = fake({ "eslint.fix.touch": true });
    const abs = join(dir, "src", "a.ts");
    const r = await runEslint(dir, "src/a.ts", 5_000);
    expect(argvOf(dir, "eslint")).toEqual([`--fix ${abs}`]);
    expect(readFileSync(abs, "utf-8")).toContain("// fixed");
    expect(r.ok).toBe(true);
    expect(r.fixMode).toBe("file");
    expect(r.autoFixed).toBe(true);
  }, 10_000);
});

describe("resolveQualityTarget", () => {
  it("resolves relative paths against the project", () => {
    const dir = fake();
    expect(resolveQualityTarget(dir, "src/a.ts")).toBe(
      join(dir, "src", "a.ts"),
    );
    expect(resolveQualityTarget(dir, join(dir, "src", "a.ts"))).toBe(
      join(dir, "src", "a.ts"),
    );
  });

  it("refuses a file outside the project", () => {
    const dir = fake();
    expect(() => resolveQualityTarget(dir, "../elsewhere.ts")).toThrow(
      /outside the project/,
    );
    expect(() => resolveQualityTarget(dir, "/etc/hosts")).toThrow(
      /outside the project/,
    );
    expect(() => resolveQualityTarget(dir, dir)).toThrow(/outside the project/);
  });

  it("refuses a symlink that escapes the project", () => {
    const dir = fake();
    const outside = fake();
    Bun.spawnSync(["ln", "-s", join(outside, "src"), join(dir, "link")]);
    expect(() => resolveQualityTarget(dir, "link/a.ts")).toThrow(
      /outside the project/,
    );
  });

  it("the runners refuse an outside file without spawning anything", async () => {
    const dir = fake();
    await expect(runPrettier(dir, "/etc/hosts", 5_000)).rejects.toThrow(
      /outside the project/,
    );
    await expect(runEslint(dir, "../x.ts", 5_000)).rejects.toThrow(
      /outside the project/,
    );
    expect(argvOf(dir, "prettier")).toEqual([]);
    expect(argvOf(dir, "eslint")).toEqual([]);
  });
});
