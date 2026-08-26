import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlanFiles, type PlanTaskFiles } from "./plan-files.js";
import { extractSpecFiles } from "./helpers.js";

/**
 * Fixture plan exercising every shape the real corpus (and the shipped
 * template at `targets/claude-code/commands/spec-plan.md:186-192`) produces.
 */
const FIXTURE_PLAN = `# Fixture Plan

Created: 2026-08-24
Status: IN_PROGRESS

## Summary

A stray verb line outside any task must never be attributed to a task:

- Modify: \`src/never-attributed.ts\`

## Implementation Tasks

### Task 1: First task

**Objective:** Something.
**Dependencies:** None
**Wave:** 1

**Files:**

- Create: \`src/new-thing.ts\`
- Modify: \`src/exists-here.ts\`
- Test: \`src/new-thing.test.ts\`

**Key Decisions / Notes:**

- Prose mentioning \`src/not-a-file-entry.ts\` must not be captured.
- Add: a note that is not a path

**Definition of Done:**

- [ ] Works

---

### Task 1a: Suffixed task

**Objective:** Real plans use \`### Task 1a:\` / \`### Task 1b:\` headings.
**Wave:** 2 (moved from Wave 1 — now gated by Task 1)

**Files:**

- Modify: \`src/a.ts\`, \`src/b.ts\`, \`src/c.ts\`
- Delete: src/bare-unticked.ts

---

### Task 2: Unfilled wave placeholder

**Objective:** The shipped template ships a literal placeholder.
**Wave:** [1 | 2 | ...]

**Files:**

- Modify: \`src/placeholder-wave.ts\`

---

### Task 3: Verify

**Objective:** A task with no Files block at all.
**Wave:** 3

**Definition of Done:**

- [ ] Full suite passes

---

### Task 4: Fenced example

**Objective:** Task headings inside code fences are documentation, not tasks.
**Wave:** 4

**Files:**

- Modify: \`src/fenced-owner.ts\`

**Key Decisions / Notes:**

\`\`\`markdown
### Task 99: Not a real task

**Files:**

- Create: \`src/should-not-appear.ts\`
\`\`\`

---

### Task 5: Inline Files form

**Objective:** Bugfix plans state files inline on the marker line, with no verb.
**Files:** \`src/inline-one.ts\`, new \`src/inline-two.ts\`
**Verify:** \`bun test\`

---

### Task 6 Evidence

Not a task heading (no colon) — appendix prose only.

- Modify: \`src/appendix.ts\`
`;

let dir: string;
let planPath: string;
let tasks: PlanTaskFiles[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinal-plan-files-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "exists-here.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  planPath = join(dir, "plan.md");
  writeFileSync(planPath, FIXTURE_PLAN);
  tasks = parsePlanFiles(planPath, dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byId = (id: string): PlanTaskFiles => {
  const t = tasks.find((x) => x.id === id);
  if (!t)
    throw new Error(
      `no task with id ${id}; got ${tasks.map((x) => x.id).join(", ")}`,
    );
  return t;
};

describe("parsePlanFiles — per-task grouping", () => {
  it("returns one entry per `### Task N:` heading, in document order", () => {
    expect(tasks.map((t) => t.id)).toEqual(["1", "1a", "2", "3", "4", "5"]);
  });

  it("carries the heading title", () => {
    expect(byId("1").title).toBe("First task");
    expect(byId("3").title).toBe("Verify");
  });

  it("attributes each file to the task whose Files block contains it", () => {
    expect(byId("1").files.map((f) => f.path)).toEqual([
      "src/new-thing.ts",
      "src/exists-here.ts",
      "src/new-thing.test.ts",
    ]);
  });

  it("never attributes verb lines outside any task", () => {
    const all = tasks.flatMap((t) => t.files.map((f) => f.path));
    expect(all).not.toContain("src/never-attributed.ts");
  });

  it("only reads the Files block, not the Notes block", () => {
    const all = tasks.flatMap((t) => t.files.map((f) => f.path));
    expect(all).not.toContain("src/not-a-file-entry.ts");
  });

  it("yields an empty files array for a task with no Files block", () => {
    expect(byId("3").files).toEqual([]);
  });
});

describe("parsePlanFiles — task numbering", () => {
  it("exposes the raw heading label as `id` and the leading integer as `task`", () => {
    expect(byId("1a").id).toBe("1a");
    expect(byId("1a").task).toBe(1);
    expect(byId("1").task).toBe(1);
  });

  it("does not crash on a `Task Na` suffix and keeps both entries distinct", () => {
    expect(tasks.filter((t) => t.task === 1)).toHaveLength(2);
  });

  it("ignores `### Task N <words>` headings that lack a colon", () => {
    const all = tasks.flatMap((t) => t.files.map((f) => f.path));
    expect(all).not.toContain("src/appendix.ts");
  });
});

describe("parsePlanFiles — wave", () => {
  it("parses a plain numeric wave", () => {
    expect(byId("1").wave).toBe(1);
  });

  it("parses the leading number when trailing prose follows", () => {
    expect(byId("1a").wave).toBe(2);
  });

  it("yields null (not NaN, not a throw) for the unfilled `[1 | 2 | ...]` placeholder", () => {
    const w = byId("2").wave;
    expect(w).toBeNull();
    expect(Number.isNaN(w as unknown as number)).toBe(false);
  });
});

describe("parsePlanFiles — verbs, paths, existence", () => {
  it("maps template verbs onto the four-value union", () => {
    const verbs = Object.fromEntries(
      byId("1").files.map((f) => [f.path, f.verb]),
    );
    expect(verbs["src/new-thing.ts"]).toBe("create");
    expect(verbs["src/exists-here.ts"]).toBe("modify");
    expect(verbs["src/new-thing.test.ts"]).toBe("test");
    expect(
      byId("1a").files.find((f) => f.path === "src/bare-unticked.ts")?.verb,
    ).toBe("delete");
  });

  it("strips backticks via the shared normalizer", () => {
    for (const t of tasks)
      for (const f of t.files) expect(f.path).not.toContain("`");
  });

  it("captures every path on a comma-separated backticked line", () => {
    expect(byId("1a").files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/bare-unticked.ts",
    ]);
  });

  it("checks existence on disk relative to projectRoot", () => {
    expect(
      byId("1").files.find((f) => f.path === "src/exists-here.ts")?.exists,
    ).toBe(true);
    // Create: targets do not exist yet — load-bearing: reach must not be scored for them.
    expect(
      byId("1").files.find((f) => f.path === "src/new-thing.ts")?.exists,
    ).toBe(false);
    expect(byId("1a").files.find((f) => f.path === "src/a.ts")?.exists).toBe(
      true,
    );
    expect(byId("1a").files.find((f) => f.path === "src/b.ts")?.exists).toBe(
      false,
    );
  });

  it("skips task headings and Files blocks inside fenced code blocks", () => {
    expect(tasks.map((t) => t.id)).not.toContain("99");
    const all = tasks.flatMap((t) => t.files.map((f) => f.path));
    expect(all).not.toContain("src/should-not-appear.ts");
    expect(byId("4").files.map((f) => f.path)).toEqual(["src/fenced-owner.ts"]);
  });

  it("captures the inline `**Files:** `a.ts`, `b.ts`` form used by bugfix plans", () => {
    expect(byId("5").files).toEqual([
      { path: "src/inline-one.ts", verb: "modify", exists: false },
      { path: "src/inline-two.ts", verb: "modify", exists: false },
    ]);
  });

  it("does not leak the inline `**Verify:**` command into files", () => {
    expect(byId("5").files.map((f) => f.path)).not.toContain("bun test");
  });

  it("drops non-path prose that happens to sit in a Files block", () => {
    const stray = join(dir, "stray.md");
    writeFileSync(
      stray,
      [
        "### Task 1: T",
        "",
        "**Files:**",
        "",
        "- Create: sibling(s)",
        "- Test: existing tests in each module",
        "- Modify: `src/real.ts`",
        "",
      ].join("\n"),
    );
    const [t] = parsePlanFiles(stray, dir);
    expect(t.files.map((f) => f.path)).toEqual(["src/real.ts"]);
  });
});

describe("parsePlanFiles — robustness", () => {
  it("returns [] for a nonexistent plan file rather than throwing", () => {
    expect(parsePlanFiles(join(dir, "nope.md"), dir)).toEqual([]);
  });

  it("returns [] for a plan with no task headings", () => {
    const p = join(dir, "empty.md");
    writeFileSync(p, "# Just a doc\n\nNothing here.\n");
    expect(parsePlanFiles(p, dir)).toEqual([]);
  });
});

/**
 * Pre-Mortem 1 (`docs/plans/2026-08-24-code-graph-impact-planning.md:128`):
 * the trigger is <90% agreement with what a human reading the plan would
 * identify.
 *
 * `extractSpecFiles` is the closest mechanical proxy, but it is NOT a clean
 * oracle: it scans the whole document flat, so it also swallows verb bullets
 * from `**Key Decisions / Notes:**` blocks, which in this corpus are mostly
 * *symbol* names — `- Add: \`migrateV6()\``, `- Add: \`SCHEMA_VERSION\``,
 * `- Modify: \`countImporters\``. Those are not files and a human would not
 * count them. The comparison is therefore restricted to flat tokens that are
 * path-shaped, which is the same filter the parser itself applies.
 */
const PATH_SHAPED = (p: string): boolean =>
  p.includes("/") || /\.[A-Za-z0-9]+$/.test(p);
describe("parsePlanFiles — real corpus", () => {
  const repoRoot = process.cwd();
  const plansDir = join(repoRoot, "docs", "plans");
  const planFiles = readdirSync(plansDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  it("finds a non-trivial corpus to validate against", () => {
    expect(planFiles.length).toBeGreaterThan(50);
  });

  it("parses every plan in docs/plans/ without throwing, and reports coverage", () => {
    let totalTasks = 0;
    let totalFiles = 0;
    let tasksWithWave = 0;
    let existing = 0;
    const rows: string[] = [];

    for (const name of planFiles) {
      const path = join(plansDir, name);
      let parsed: PlanTaskFiles[] = [];
      expect(() => {
        parsed = parsePlanFiles(path, repoRoot);
      }).not.toThrow();

      const files = parsed.flatMap((t) => t.files);
      totalTasks += parsed.length;
      totalFiles += files.length;
      tasksWithWave += parsed.filter((t) => t.wave !== null).length;
      existing += files.filter((f) => f.exists).length;

      // Every task's shape is well-formed.
      for (const t of parsed) {
        expect(Number.isFinite(t.task)).toBe(true);
        expect(t.wave === null || Number.isFinite(t.wave)).toBe(true);
        expect(typeof t.title).toBe("string");
        for (const f of t.files) {
          expect(f.path.length).toBeGreaterThan(0);
          expect(["create", "modify", "test", "delete"]).toContain(f.verb);
        }
      }

      if (parsed.length > 0) {
        rows.push(
          `  ${name}: ${parsed.length} tasks, ${files.length} files, ` +
            `${parsed.filter((t) => t.wave !== null).length} waved`,
        );
      }
    }

    console.log(
      `\n[plan-files corpus] ${planFiles.length} plans | ${totalTasks} tasks | ` +
        `${totalFiles} files | ${tasksWithWave} tasks with a wave | ${existing} files on disk\n` +
        rows.join("\n"),
    );

    expect(totalTasks).toBeGreaterThan(400);
    expect(totalFiles).toBeGreaterThan(800);
  });

  it("recovers >=90% of the paths the flat extractor finds (Pre-Mortem 1 trigger)", () => {
    let flatTotal = 0;
    let recovered = 0;
    const worst: Array<{ name: string; pct: number; missed: string[] }> = [];

    for (const name of planFiles) {
      const path = join(plansDir, name);
      const flat = [...extractSpecFiles(path)].filter(PATH_SHAPED);
      if (flat.length === 0) continue;
      const mine = new Set(
        parsePlanFiles(path, repoRoot).flatMap((t) =>
          t.files.map((f) => f.path),
        ),
      );
      const missed = flat.filter((f) => !mine.has(f));
      flatTotal += flat.length;
      recovered += flat.length - missed.length;
      if (missed.length > 0) {
        worst.push({
          name,
          pct: ((flat.length - missed.length) / flat.length) * 100,
          missed: missed.slice(0, 5),
        });
      }
    }

    const pct = (recovered / flatTotal) * 100;
    worst.sort((a, b) => a.pct - b.pct);
    console.log(
      `\n[plan-files agreement] ${recovered}/${flatTotal} = ${pct.toFixed(1)}% of flat-extracted paths attributed to a task.\n` +
        worst
          .slice(0, 10)
          .map(
            (w) =>
              `  ${w.name}: ${w.pct.toFixed(0)}% (missed e.g. ${w.missed.join(", ")})`,
          )
          .join("\n"),
    );

    // Pre-Mortem 1's trigger is 90%. Measured 99.7% (1011/1014) on 2026-08-25;
    // asserting 95 leaves room for corpus growth without being vacuous.
    expect(pct).toBeGreaterThanOrEqual(95);
  });
});
