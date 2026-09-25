/**
 * Dedupe signature + volatile-content normalizer (hardening-sweep Task 15, D10).
 *
 * Fixtures are REAL tool output (bun test v1.3.10, tsc --extendedDiagnostics)
 * captured from two runs of the same failing test — Pre-Mortem 3: the dedupe
 * is only as good as the normalizer's coverage of what actually varies.
 */

import { describe, it, expect } from "bun:test";
import {
  AUTO_CAPTURE_SOURCES,
  computeDedupeSignature,
  isAutoCapture,
  normalizeVolatile,
} from "./dedupe-signature.js";

// Two real runs of the same failing bun test, from different temp dirs.
const BUN_RUN_1 = `bun test v1.3.10 (30e609e0)

x.test.ts:
1 | import {it,expect} from "bun:test";
2 | it("a",()=>{expect(1).toBe(2)});
                          ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/private/var/folders/4k/tpqrs7ss4xdc2002kpv4njzh0000gn/T/opencode/dd/x.test.ts:2:23)
(fail) a [4.77ms]

 1 pass
 1 fail
 2 expect() calls
Ran 2 tests across 1 file. [122.00ms]`;

const BUN_RUN_2 = `bun test v1.3.11 (4b1c9f2a)

x.test.ts:
1 | import {it,expect} from "bun:test";
2 | it("a",()=>{expect(1).toBe(2)});
                          ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/var/folders/zz/qq81n0000gn/T/sentinal-test-home-abc/x.test.ts:2:23)
(fail) a [0.72ms]

 3 pass
 1 fail
 5 expect() calls
Ran 4 tests across 2 files. [16.00ms]`;

// Same shape, genuinely different failure.
const BUN_OTHER = BUN_RUN_1.replace(
  "Expected: 2\nReceived: 1",
  'Expected: "ok"\nReceived: undefined',
);

const TSC_RUN_1 = `y.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
Files:              83
Lines:           58446
Memory used:    64774K
Memory allocs:  277349
Parse time:     0.024s
Check time:     0.157s
Total time:     0.198s`;

const TSC_RUN_2 = `y.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
Files:              84
Lines:           58512
Memory used:    65102K
Memory allocs:  278001
Parse time:     0.031s
Check time:     1.2s
Total time:     1.3s`;

const TSC_OTHER = TSC_RUN_1.replace("TS2322", "TS2307");

function autoFix(content: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "fix",
    title: "Fixed issue in x.test.ts",
    content,
    metadata: { source: "auto-capture" },
    ...overrides,
  };
}

describe("normalizeVolatile", () => {
  it("strips bun version banners", () => {
    expect(normalizeVolatile("bun test v1.3.10 (30e609e0)")).toBe(
      normalizeVolatile("bun test v1.2.0 (deadbee1)"),
    );
  });

  it("strips durations in all real forms", () => {
    for (const [a, b] of [
      ["(fail) a [4.77ms]", "(fail) a [0.72ms]"],
      ["Check time: 0.157s", "Check time: 1.2s"],
      ["Done in 12ms", "Done in 3400ms"],
      ["took 1.5 s", "took 12 s"],
    ]) {
      expect(normalizeVolatile(a!)).toBe(normalizeVolatile(b!));
    }
  });

  it("strips varying counts", () => {
    expect(normalizeVolatile("Ran 12 tests across 3 files.")).toBe(
      normalizeVolatile("Ran 1 test across 1 file."),
    );
    expect(normalizeVolatile(" 3 pass\n 7 expect() calls")).toBe(
      normalizeVolatile(" 30 pass\n 71 expect() calls"),
    );
  });

  it("keeps a non-zero fail count distinct from a passing run", () => {
    expect(normalizeVolatile(" 0 fail")).not.toBe(normalizeVolatile(" 2 fail"));
  });

  it("strips hex hashes (>= 7 chars) and uuids but keeps short words", () => {
    expect(normalizeVolatile("commit 30e609e0a")).toBe(
      normalizeVolatile("commit 4b1c9f2"),
    );
    expect(normalizeVolatile("id 550e8400-e29b-41d4-a716-446655440000")).toBe(
      normalizeVolatile("id 123e4567-e89b-12d3-a456-426614174000"),
    );
    // "defaced"/"TS2322"/line numbers are not hashes.
    expect(normalizeVolatile("defaced")).toBe("defaced");
    expect(normalizeVolatile("TS2322")).not.toBe(normalizeVolatile("TS2307"));
  });

  it("strips temp paths but keeps the file name", () => {
    const a = normalizeVolatile(
      "/private/var/folders/4k/abc/T/x/y.test.ts:2:23",
    );
    const b = normalizeVolatile("/var/folders/zz/q/T/other/y.test.ts:2:23");
    const c = normalizeVolatile("/tmp/sentinal-123/y.test.ts:2:23");
    const d = normalizeVolatile("/private/tmp/zzz/y.test.ts:2:23");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toContain("y.test.ts");
    expect(a).not.toBe(normalizeVolatile("/tmp/sentinal-123/z.test.ts:2:23"));
  });

  it("does not touch real (non-temp) project paths", () => {
    expect(normalizeVolatile("/Users/me/app/src/a.ts")).not.toBe(
      normalizeVolatile("/Users/me/app/src/b.ts"),
    );
  });

  it("strips ISO and clock timestamps", () => {
    expect(normalizeVolatile("at 2026-09-25T10:11:12.345Z")).toBe(
      normalizeVolatile("at 2026-01-02T00:00:00Z"),
    );
    expect(normalizeVolatile("[10:11:12 AM] Found 1 error")).toBe(
      normalizeVolatile("[4:05:06 PM] Found 1 error"),
    );
  });

  it("strips tsc --extendedDiagnostics statistic lines", () => {
    expect(normalizeVolatile(TSC_RUN_1)).toBe(normalizeVolatile(TSC_RUN_2));
    expect(normalizeVolatile(TSC_RUN_1)).not.toBe(normalizeVolatile(TSC_OTHER));
  });

  it("collapses two real bun runs of the same failure", () => {
    expect(normalizeVolatile(BUN_RUN_1)).toBe(normalizeVolatile(BUN_RUN_2));
    expect(normalizeVolatile(BUN_RUN_1)).not.toBe(normalizeVolatile(BUN_OTHER));
  });
});

describe("computeDedupeSignature", () => {
  it("recognises the sources real traffic sends", () => {
    // CC memory-observer + plugin analyzeEvent path, and both tool-failure paths.
    expect([...AUTO_CAPTURE_SOURCES].sort()).toEqual([
      "auto-capture",
      "auto-capture-failure",
    ]);
    expect(isAutoCapture({ source: "auto-capture" })).toBe(true);
    expect(isAutoCapture({ source: "auto-capture-failure" })).toBe(true);
    expect(isAutoCapture({ source: "mcp-tool" })).toBe(false);
    expect(isAutoCapture(undefined)).toBe(false);
  });

  it("is null for manual observations (no source, mcp-tool, session-end)", () => {
    for (const metadata of [
      {},
      undefined,
      { source: "mcp-tool" },
      { source: "session-end" },
      { dedupeKey: "" },
    ]) {
      expect(
        computeDedupeSignature({ ...autoFix("x"), metadata } as never),
      ).toBeNull();
    }
  });

  it("is a stable sha1 hex for auto-captures", () => {
    const s = computeDedupeSignature(autoFix(BUN_RUN_1));
    expect(s).toMatch(/^[0-9a-f]{40}$/);
    expect(computeDedupeSignature(autoFix(BUN_RUN_1))).toBe(s);
  });

  it("collapses volatile-only differences (real bun and tsc variants)", () => {
    expect(computeDedupeSignature(autoFix(BUN_RUN_1))).toBe(
      computeDedupeSignature(autoFix(BUN_RUN_2)),
    );
    expect(computeDedupeSignature(autoFix(TSC_RUN_1))).toBe(
      computeDedupeSignature(autoFix(TSC_RUN_2)),
    );
  });

  it("keeps genuinely different content, title or type apart", () => {
    const base = computeDedupeSignature(autoFix(BUN_RUN_1));
    expect(computeDedupeSignature(autoFix(BUN_OTHER))).not.toBe(base);
    expect(
      computeDedupeSignature(
        autoFix(BUN_RUN_1, { title: "Fixed issue in y.ts" }),
      ),
    ).not.toBe(base);
    expect(
      computeDedupeSignature(autoFix(BUN_RUN_1, { type: "pattern" })),
    ).not.toBe(base);
  });

  it("collapses truncated captures whose cut point moved with a volatile width", () => {
    // capture.ts slices raw output to 500 chars; a wider duration moves the
    // cut, so the (partial) last line of a capped section must not count.
    const body = "x".repeat(60) + "\n";
    const raw1 = `${body.repeat(7)}(fail) a [4.77ms]\n${"y".repeat(80)}`;
    const raw2 = `${body.repeat(7)}(fail) a [122.00ms]\n${"y".repeat(80)}`;
    const c1 = `**Error:** ${raw1.slice(0, 500)}\n\n**Fixed in:** src/a.ts`;
    const c2 = `**Error:** ${raw2.slice(0, 500)}\n\n**Fixed in:** src/a.ts`;
    expect(c1).not.toBe(c2);
    expect(computeDedupeSignature(autoFix(c1))).toBe(
      computeDedupeSignature(autoFix(c2)),
    );
  });

  it("with a dedupeKey, keys on (type, title, key) — content may vary", () => {
    const obs = (content: string, dedupeKey: string) => ({
      type: "discovery",
      title: "Instructions loaded: CLAUDE.md",
      content,
      metadata: { source: "instructions-loaded", dedupeKey },
    });
    const a = computeDedupeSignature(
      obs("Load reason: session_start", "/p/CLAUDE.md"),
    );
    const b = computeDedupeSignature(
      obs("Load reason: path_glob_match", "/p/CLAUDE.md"),
    );
    const c = computeDedupeSignature(
      obs("Load reason: session_start", "/p/sub/CLAUDE.md"),
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
