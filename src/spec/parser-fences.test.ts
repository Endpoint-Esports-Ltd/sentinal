import { describe, it, expect } from "bun:test";
import { markFencedLines, dedupeTasksByPosition } from "./parser-fences.js";
import type { SpecTask } from "./types.js";

describe("markFencedLines", () => {
  it("marks fence delimiters and enclosed lines as fenced", () => {
    const lines = ["before", "```", "inside", "```", "after"];
    expect(markFencedLines(lines)).toEqual([false, true, true, true, false]);
  });

  it("handles info strings on the opening fence", () => {
    const lines = ["```typescript", "const x = 1;", "```", "after"];
    expect(markFencedLines(lines)).toEqual([true, true, true, false]);
  });

  it("handles ~~~ fences", () => {
    const lines = ["~~~", "inside", "~~~", "after"];
    expect(markFencedLines(lines)).toEqual([true, true, true, false]);
  });

  it("handles indented fences (list-nested)", () => {
    const lines = ["- item:", "  ```", "  ### Task 9: nope", "  ```", "done"];
    expect(markFencedLines(lines)).toEqual([false, true, true, true, false]);
  });

  it("marks everything after an unclosed fence as fenced", () => {
    const lines = ["a", "```", "b", "c"];
    expect(markFencedLines(lines)).toEqual([false, true, true, true]);
  });

  it("does not treat inline backticks as fences", () => {
    const lines = ["use `code` here", "- [ ] Task 1: real"];
    expect(markFencedLines(lines)).toEqual([false, false]);
  });
});

describe("dedupeTasksByPosition", () => {
  const t = (position: number, title: string): SpecTask => ({
    position,
    title,
    status: "pending",
  });

  it("keeps unique positions untouched", () => {
    const tasks = [t(1, "a"), t(2, "b")];
    expect(dedupeTasksByPosition(tasks)).toEqual(tasks);
  });

  it("last occurrence wins for duplicate positions", () => {
    const result = dedupeTasksByPosition([t(1, "old"), t(2, "b"), t(1, "new")]);
    expect(result).toHaveLength(2);
    expect(result.find((x) => x.position === 1)?.title).toBe("new");
  });

  it("preserves first-occurrence ordering", () => {
    const result = dedupeTasksByPosition([t(2, "b"), t(1, "old"), t(1, "new")]);
    expect(result.map((x) => x.position)).toEqual([2, 1]);
  });
});
