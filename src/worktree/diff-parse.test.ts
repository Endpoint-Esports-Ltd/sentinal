/**
 * `git diff --numstat` parsing, extracted from manager.ts (R4).
 * Behaviour must be byte-identical to the inlined version.
 */

import { describe, it, expect } from "bun:test";
import { parseNumstat } from "./diff-parse.js";

describe("parseNumstat", () => {
  it("returns an empty summary for empty output", () => {
    expect(parseNumstat("")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    });
  });

  it("totals insertions and deletions across files", () => {
    const s = parseNumstat("10\t5\tsrc/a.ts\n3\t2\tsrc/b.ts\n");
    expect(s.filesChanged).toBe(2);
    expect(s.insertions).toBe(13);
    expect(s.deletions).toBe(7);
  });

  it("classifies added / deleted / modified", () => {
    const s = parseNumstat("4\t0\tadd.ts\n0\t9\tdel.ts\n2\t2\tmod.ts\n");
    expect(s.files.map((f) => f.status)).toEqual([
      "added",
      "deleted",
      "modified",
    ]);
  });

  it("classifies renames by the ' => ' marker", () => {
    const s = parseNumstat("1\t1\told.ts => new.ts\n");
    expect(s.files[0].status).toBe("renamed");
    expect(s.files[0].path).toBe("old.ts => new.ts");
  });

  it("treats binary files ('-' columns) as zero-line modifications", () => {
    const s = parseNumstat("-\t-\timage.png\n");
    expect(s.filesChanged).toBe(1);
    expect(s.insertions).toBe(0);
    expect(s.deletions).toBe(0);
    expect(s.files[0].status).toBe("modified");
  });

  it("ignores non-numstat lines (the --stat half of the combined output)", () => {
    const s = parseNumstat(
      " src/a.ts | 2 +-\n 1 file changed\n7\t1\tsrc/a.ts\n",
    );
    expect(s.filesChanged).toBe(1);
    expect(s.insertions).toBe(7);
  });
});
