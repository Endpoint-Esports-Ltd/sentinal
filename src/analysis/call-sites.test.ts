/**
 * Unit tests for the call-site renderer.
 *
 * `impact.test.ts` already exercises this section end-to-end through the
 * registered MCP handler, which is where the placement and verdict-invariance
 * properties belong. These tests cover what that level cannot reach cheaply:
 * the exact cap values, the ordering rule, and the fact that the renderer is a
 * pure function of its input — a handler-level test would have to synthesise
 * dozens of files on disk to say any of it.
 */

import { describe, it, expect } from "bun:test";
import {
  renderCallSites,
  CALL_SITES_PER_TARGET,
  CALL_SITE_TARGETS,
} from "./call-sites.js";
import type { CallSite } from "./reach.js";

function site(over: Partial<CallSite> = {}): CallSite {
  return {
    file: "src/caller.ts",
    line: 1,
    caller: "doWork",
    callee: "target",
    target: "src/target.ts",
    ...over,
  };
}

describe("renderCallSites", () => {
  it("should emit nothing at all for an empty list", () => {
    // Not an empty heading — the built-in resolver never supplies call sites,
    // so the default report must be byte-identical to having no section.
    expect(renderCallSites([])).toEqual([]);
  });

  it("should render exactly `file:line` with caller and callee", () => {
    const out = renderCallSites([
      site({ file: "src/a.ts", line: 42, caller: "handle", callee: "resolve" }),
    ]);

    expect(out).toContain("- `src/a.ts:42` — `handle` → `resolve`");
  });

  it("should order groups by evidence count, breaking ties by path", () => {
    const out = renderCallSites([
      site({ target: "src/zebra.ts" }),
      site({ target: "src/apple.ts" }),
      site({ target: "src/many.ts" }),
      site({ target: "src/many.ts", line: 2 }),
    ]).join("\n");

    const at = (p: string) => out.indexOf(`**\`${p}\`**`);
    // Two sites beats one...
    expect(at("src/many.ts")).toBeLessThan(at("src/apple.ts"));
    // ...and equal counts fall back to path order, so the section is stable.
    expect(at("src/apple.ts")).toBeLessThan(at("src/zebra.ts"));
  });

  it("should cap one file at CALL_SITES_PER_TARGET and name the remainder", () => {
    const many = Array.from({ length: CALL_SITES_PER_TARGET + 3 }, (_, i) =>
      site({ file: `src/c${i}.ts`, line: i + 1 }),
    );
    const out = renderCallSites(many);

    const rendered = out.filter((l) => /^- `src\/c\d+\.ts:\d+`/.test(l));
    expect(rendered).toHaveLength(CALL_SITES_PER_TARGET);
    expect(out).toContain("- …and 3 more call sites for this file");
  });

  it("should cap the group count at CALL_SITE_TARGETS and name the remainder", () => {
    // One site per target, so every group is the same size and the cap — not
    // the ordering — is what drops the tail.
    const many = Array.from({ length: CALL_SITE_TARGETS + 2 }, (_, i) =>
      site({ target: `src/t${String(i).padStart(2, "0")}.ts` }),
    );
    const out = renderCallSites(many);

    const headings = out.filter((l) => l.startsWith("**`src/t"));
    expect(headings).toHaveLength(CALL_SITE_TARGETS);
    expect(out).toContain(
      "- …and 2 more call sites across 2 further changed files",
    );
  });

  it("should singularise the omitted-count lines for a remainder of one", () => {
    const out = renderCallSites([
      ...Array.from({ length: CALL_SITES_PER_TARGET + 1 }, (_, i) =>
        site({ line: i + 1 }),
      ),
      ...Array.from({ length: CALL_SITE_TARGETS }, (_, i) =>
        site({ target: `src/t${i}.ts` }),
      ),
    ]);

    expect(out).toContain("- …and 1 more call site for this file");
    expect(out).toContain(
      "- …and 1 more call site across 1 further changed file",
    );
  });

  it("should attribute the data and state that it was not scored", () => {
    const out = renderCallSites([site()]).join("\n");

    // Mirrors `reachAttribution`'s register in `impact.ts`.
    expect(out).toContain("### Call Sites");
    expect(out).toContain("- Call sites: agent-supplied —");
    expect(out).toContain("evidence only (never scored)");
    expect(out).toContain("1 call site across 1 changed file,");
  });
});
