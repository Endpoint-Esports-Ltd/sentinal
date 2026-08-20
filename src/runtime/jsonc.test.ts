/**
 * JSONC comment stripping (Phase 3).
 *
 * Needed by BOTH halves of the contract: the scaffolder's rule is "prefer
 * leaving a field empty **with a comment** over guessing", so the file it
 * drafts is JSONC by construction — which means the loader has to accept the
 * very thing Sentinal itself produces.
 */

import { describe, it, expect } from "bun:test";
import { stripJsonComments } from "./jsonc.js";

describe("stripJsonComments", () => {
  it("removes line and block comments", () => {
    expect(
      JSON.parse(
        stripJsonComments('{\n  // note\n  "up": "x" /* trailing */\n}'),
      ),
    ).toEqual({ up: "x" });
  });

  it("leaves comment-like sequences INSIDE strings alone", () => {
    // The single most likely real-world case: a URL in a readiness target.
    expect(
      JSON.parse(stripJsonComments('{"up":"curl http://x//y /* z */"}')),
    ).toEqual({ up: "curl http://x//y /* z */" });
  });

  it("handles escaped quotes inside strings", () => {
    expect(
      JSON.parse(stripJsonComments('{"up":"say \\"hi\\" // no"}')),
    ).toEqual({ up: 'say "hi" // no' });
  });

  it("handles an escaped backslash immediately before a closing quote", () => {
    expect(JSON.parse(stripJsonComments('{"up":"back\\\\"}'))).toEqual({
      up: "back\\",
    });
  });

  it("preserves newlines so error line numbers stay meaningful", () => {
    const stripped = stripJsonComments('{\n// a\n// b\n"x":1\n}');
    expect(stripped.split("\n").length).toBe(5);
  });

  it("is a no-op on plain JSON", () => {
    expect(stripJsonComments('{"a":1}')).toBe('{"a":1}');
  });

  it("tolerates an unterminated block comment without hanging", () => {
    expect(stripJsonComments('{"a":1} /* oops')).toContain('{"a":1}');
  });
});
