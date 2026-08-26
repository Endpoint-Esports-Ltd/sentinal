/**
 * Analysis helpers tests.
 *
 * `helpers.ts` shipped without a companion test. This covers `countImporters`,
 * which is replaced in this plan, plus the neighbours it is composed with so a
 * regression in the swap is visible.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeTmpDir } from "../test-helpers.js";
import {
  countImporters,
  countLines,
  isExpectedFile,
  countUniqueFiles,
  extractSpecFiles,
} from "./helpers.js";

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("countImporters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-helpers");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return 0 when nothing imports the file", () => {
    write(tmpDir, "src/lonely.ts", "export const x = 1;\n");
    expect(countImporters("src/lonely.ts", tmpDir)).toBe(0);
  });

  it("should count a direct importer", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/caller.ts", 'import { t } from "./target.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(1);
  });

  it("should count a transitive importer", () => {
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/mid.ts", 'import { t } from "./target.js";\n');
    write(tmpDir, "src/leaf.ts", 'import { m } from "./mid.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(2);
  });

  it("should not count the file itself", () => {
    write(tmpDir, "src/target.ts", 'import { x } from "./target.js";\n');
    expect(countImporters("src/target.ts", tmpDir)).toBe(0);
  });

  it("should not count a same-named file in another directory", () => {
    // The old grep matched on basename, so `src/b/target.ts` polluted the
    // count for `src/a/target.ts`.
    write(tmpDir, "src/a/target.ts", "export const t = 1;\n");
    write(tmpDir, "src/b/target.ts", "export const t = 2;\n");
    write(tmpDir, "src/b/caller.ts", 'import { t } from "./target.js";\n');
    expect(countImporters("src/a/target.ts", tmpDir)).toBe(0);
    expect(countImporters("src/b/target.ts", tmpDir)).toBe(1);
  });

  it("should return 0 for a file outside the scanned tree", () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    expect(countImporters("nope/missing.ts", tmpDir)).toBe(0);
  });
});

describe("countLines / isExpectedFile / countUniqueFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-helpers2");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should count lines and return 0 for a missing file", () => {
    write(tmpDir, "a.ts", "one\ntwo\nthree");
    expect(countLines(join(tmpDir, "a.ts"))).toBe(3);
    expect(countLines(join(tmpDir, "missing.ts"))).toBe(0);
  });

  it("should treat every file as expected when the spec set is empty", () => {
    expect(isExpectedFile("src/anything.ts", new Set())).toBe(true);
  });

  it("should suffix-match a changed path against the spec set", () => {
    const spec = new Set(["src/auth/auth.service.ts"]);
    expect(isExpectedFile("src/auth/auth.service.ts", spec)).toBe(true);
    expect(isExpectedFile("src/other.ts", spec)).toBe(false);
  });

  it("should count unique files across diagnostics", () => {
    expect(
      countUniqueFiles([
        { file: "a.ts", line: 1, column: 1, message: "x" },
        { file: "a.ts", line: 2, column: 1, message: "y" },
        { file: "b.ts", line: 1, column: 1, message: "z" },
      ]),
    ).toBe(2);
  });
});

// --- extractSpecFiles: every verb the SHIPPED template emits ---

/**
 * The verb list is **derived from the shipped template**, never hand-written.
 *
 * `Test:` went unmatched for the entire life of `extractSpecFiles` precisely
 * because the regex was a hand-maintained literal that nobody re-checked when
 * `spec-plan.md` grew a third verb. A hardcoded list here would reproduce that
 * failure mode exactly: the next verb the template gains would be silently
 * dropped, and this test would still pass. Reading the template makes the test
 * fail the moment the two drift.
 */
const SPEC_PLAN_TEMPLATE = join(
  import.meta.dir,
  "..",
  "..",
  "targets",
  "claude-code",
  "commands",
  "spec-plan.md",
);

function templateFileVerbs(): string[] {
  const src = readFileSync(SPEC_PLAN_TEMPLATE, "utf-8");
  const marker = "**Files:**";
  const at = src.indexOf(marker);
  if (at === -1) {
    throw new Error(
      `${SPEC_PLAN_TEMPLATE} no longer contains a "${marker}" block — the verb derivation is broken, not the regex under test.`,
    );
  }
  // The Files block runs to the next bold heading. Deliberately NOT scoped by
  // the ``` fence: the template nests fences and an indented closing fence
  // makes fence-pairing unreliable.
  const rest = src.slice(at + marker.length);
  const end = rest.search(/\n\*\*/);
  const filesSection = end === -1 ? rest : rest.slice(0, end);
  const verbs = [
    ...new Set(
      [...filesSection.matchAll(/^-\s+([A-Za-z]+):/gm)].map((m) => m[1]),
    ),
  ];
  if (verbs.length === 0) {
    throw new Error(
      `No "- Verb:" lines found in the ${marker} block of ${SPEC_PLAN_TEMPLATE}.`,
    );
  }
  return verbs;
}

describe("extractSpecFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("extract-spec-files");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function planWith(body: string): string {
    const p = join(tmpDir, "docs/plans/p.md");
    write(
      tmpDir,
      "docs/plans/p.md",
      `# p\n\n### Task 1\n\n**Files:**\n${body}`,
    );
    return p;
  }

  // Table-driven over the verbs the shipped template actually demonstrates.
  for (const verb of templateFileVerbs()) {
    it(`should extract a backticked and a bare path for the template verb "${verb}:"`, () => {
      const files = extractSpecFiles(
        planWith(
          `- ${verb}: \`src/ticked/${verb.toLowerCase()}.ts\`\n- ${verb}: src/bare/${verb.toLowerCase()}.ts\n`,
        ),
      );
      expect([...files]).toContain(`src/ticked/${verb.toLowerCase()}.ts`);
      expect([...files]).toContain(`src/bare/${verb.toLowerCase()}.ts`);
    });
  }

  it("should strip a leading ./ from inside backticks", () => {
    const files = extractSpecFiles(planWith("- Modify: `./src/dot.ts`\n"));
    expect([...files]).toContain("src/dot.ts");
  });

  it("should extract every backticked path on a comma-separated line", () => {
    // The template puts one file per line, but real plans routinely write
    // `- Modify: \`a.ts\`, \`b.ts\`, \`c.ts\``. Taking only `.split(" ")[0]`
    // dropped everything after the first — and once Bug 1 is fixed, every
    // dropped path becomes a false "unexpected change" warning.
    const files = extractSpecFiles(
      planWith("- Modify: `src/a.ts`, `src/b.ts`, `src/c.ts`\n"),
    );
    expect([...files].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("should ignore prose after a backticked path", () => {
    const files = extractSpecFiles(
      planWith(
        "- Modify: `src/a.ts` (only the registration line, nothing else)\n",
      ),
    );
    expect([...files]).toEqual(["src/a.ts"]);
  });

  it("should still take the first token of an un-backticked path with a trailing comment", () => {
    const files = extractSpecFiles(
      planWith("- Create: src/new.ts  # brand new module\n"),
    );
    expect([...files]).toEqual(["src/new.ts"]);
  });

  it("should return an empty set for a missing plan file", () => {
    expect(extractSpecFiles(join(tmpDir, "nope.md")).size).toBe(0);
  });
});
