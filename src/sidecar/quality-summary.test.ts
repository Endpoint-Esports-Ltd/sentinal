/**
 * Quality Summary Tests — pure parsing helpers behind report-only mode (D1).
 * Runner-level behaviour (argv, exit codes) is in quality-runners.test.ts.
 */

import { describe, it, expect } from "bun:test";
import {
  summarizeEslintJson,
  listedFiles,
  resolveQualityTarget,
  MAX_LISTED,
} from "./quality-summary.js";

describe("summarizeEslintJson", () => {
  it("returns null for non-JSON or non-array output", () => {
    expect(summarizeEslintJson("Oops! Something went wrong", "/p")).toBeNull();
    expect(summarizeEslintJson("{}", "/p")).toBeNull();
  });

  it("totals counts, ranks rules and caps locations", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      ruleId: i < 20 ? "no-unused-vars" : "prefer-const",
      severity: i < 20 ? 2 : 1,
      line: i + 1,
    }));
    const s = summarizeEslintJson(
      JSON.stringify([{ filePath: "/p/src/a.ts", messages }]),
      "/p",
    )!;
    expect(s.errorCount).toBe(20);
    expect(s.warningCount).toBe(10);
    expect(s.topRules).toEqual([
      { rule: "no-unused-vars", count: 20 },
      { rule: "prefer-const", count: 10 },
    ]);
    expect(s.locations.length).toBe(MAX_LISTED);
    expect(s.locations[0]).toBe("src/a.ts:1 no-unused-vars");
  });
});

describe("listedFiles", () => {
  it("keeps every non-empty line", () => {
    expect(listedFiles("a.ts\n\n b.ts \n")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("resolveQualityTarget (pure paths)", () => {
  it("accepts a not-yet-existing file inside the project", () => {
    expect(resolveQualityTarget("/nonexistent/proj", "src/new.ts")).toBe(
      "/nonexistent/proj/src/new.ts",
    );
  });

  it("does not mistake a `..`-prefixed filename for an escape", () => {
    expect(resolveQualityTarget("/nonexistent/proj", "..foo.ts")).toBe(
      "/nonexistent/proj/..foo.ts",
    );
  });

  it("refuses a sibling directory sharing the project prefix", () => {
    expect(() =>
      resolveQualityTarget("/nonexistent/proj", "/nonexistent/proj-other/a.ts"),
    ).toThrow(/outside the project/);
  });
});
