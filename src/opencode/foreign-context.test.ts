import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOREIGN_RULES_TOTAL_CHARS,
  type RuleFile,
} from "../project/foreign-rules.js";
import {
  buildForeignContext,
  createForeignContext,
} from "./foreign-context.js";

const rule = (
  ws: string,
  name: string,
  body: string,
  paths?: string[],
): RuleFile => ({
  path: join(ws, ".sentinal", "rules", name),
  name,
  body,
  ...(paths ? { paths } : {}),
});

describe("buildForeignContext", () => {
  it("should format one block per project", () => {
    const out = buildForeignContext([
      {
        name: "b",
        workspace: "/b",
        rules: [rule("/b", "r.md", "# R\nrule b")],
      },
      {
        name: "c",
        workspace: "/c",
        rules: [rule("/c", "r.md", "# R\nrule c")],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Rules for b");
    expect(out[1]).toContain("rule c");
  });

  it("should degrade later projects to pointer lists under the total cap", () => {
    const big = "x".repeat(11_000);
    const out = buildForeignContext(
      [
        {
          name: "b",
          workspace: "/b",
          rules: [rule("/b", "r.md", `# B\n${big}`)],
        },
        {
          name: "c",
          workspace: "/c",
          rules: [rule("/c", "r.md", `# C\n${big}`)],
        },
        {
          name: "d",
          workspace: "/d",
          rules: [rule("/d", "r.md", `# D\n${big}`)],
        },
      ],
      FOREIGN_RULES_TOTAL_CHARS,
    );
    expect(out[0]).toContain(big);
    expect(out[1]).toContain(big);
    expect(out[2]).not.toContain(big);
    expect(out[2]).toContain("- /d/.sentinal/rules/r.md — D");
    expect(out.join("").length).toBeLessThan(FOREIGN_RULES_TOTAL_CHARS + 1_000);
  });

  it("should skip projects with no applied rules", () => {
    expect(
      buildForeignContext([{ name: "b", workspace: "/b", rules: [] }]),
    ).toEqual([]);
  });
});

describe("createForeignContext", () => {
  let root: string;
  let b: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sentinal-oc-fc-")));
    b = join(root, "b");
    mkdirSync(join(b, ".sentinal", "rules"), { recursive: true });
    writeFileSync(
      join(b, ".sentinal", "rules", "all.md"),
      "# All\nrule for all of B",
    );
    writeFileSync(
      join(b, ".sentinal", "rules", "ng.md"),
      '---\npaths:\n  - "**/*.component.ts"\n---\n# NG\nsignals in B',
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const foreignB = () => ({ identity: b, workspace: b, foreign: true });

  it("should keep a foreign project's block on every turn after an edit", () => {
    const fc = createForeignContext();
    fc.noteEdit(foreignB(), join(b, "src", "x.ts"));
    const t1 = fc.systemBlocks().join("\n");
    const t2 = fc.systemBlocks().join("\n");
    expect(t1).toContain("rule for all of B");
    expect(t2).toContain("rule for all of B");
    expect(t1).not.toContain("signals in B");
  });

  it("should add path-scoped rules once a matching file is edited", () => {
    const fc = createForeignContext();
    fc.noteEdit(foreignB(), join(b, "src", "x.ts"));
    fc.noteEdit(foreignB(), join(b, "src", "a.component.ts"));
    const text = fc.systemBlocks().join("\n");
    expect(text).toContain("signals in B");
    expect(text.match(/rule for all of B/g)).toHaveLength(1);
  });

  it("should ignore the session's own files and projects without rules", () => {
    const fc = createForeignContext();
    fc.noteEdit({ identity: "/a", workspace: "/a", foreign: false }, "/a/x.ts");
    fc.noteEdit(
      { identity: "/c", workspace: join(root, "c"), foreign: true },
      join(root, "c", "x.ts"),
    );
    expect(fc.systemBlocks()).toEqual([]);
    expect([...fc.touched().keys()]).toEqual(["/c"]);
  });

  it("should push queued hints once, newest first, at most three", () => {
    const fc = createForeignContext();
    for (const h of ["h1", "h2", "h3", "h4", "h4"]) fc.queueHint(h);
    expect(fc.systemBlocks()).toEqual(["h4", "h3", "h2"]);
    expect(fc.systemBlocks()).toEqual([]);
  });

  it("should never throw on an empty hint", () => {
    const fc = createForeignContext();
    fc.queueHint("");
    expect(fc.systemBlocks()).toEqual([]);
  });
});
