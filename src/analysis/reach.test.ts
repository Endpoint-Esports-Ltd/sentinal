/**
 * reach.ts tests — the agent-passable `reach` parameter.
 *
 * Two layers are pinned here because they guard different holes:
 *
 *   1. `AgentReachSchema` — what MCP validates before the handler ever runs.
 *      It can check shape and internal consistency (`files` values against
 *      `moduleCount`) but knows nothing about the changeset.
 *   2. `resolveReach` — what the handler runs. It is the only layer that can
 *      see the changeset, so all-or-nothing coverage lives there. It also
 *      re-checks the schema's invariants defensively, because the test harness
 *      (and any future non-MCP caller) reaches the handler without zod.
 */

import { describe, it, expect } from "bun:test";
import {
  AgentReachSchema,
  isReachRelevantPath,
  resolveReach,
  type AgentReach,
} from "./reach.js";

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
}

function rejected<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  expect(r.ok).toBe(false);
  return r as Extract<T, { ok: false }>;
}

// --- Schema ---

describe("AgentReachSchema", () => {
  it("should accept a well-formed object", () => {
    const parsed = AgentReachSchema.safeParse({
      moduleCount: 334,
      files: { "src/a.ts": 89 },
      source: "codebase-memory-mcp trace_path",
    });
    expect(parsed.success).toBe(true);
  });

  it("should accept an object without the optional source", () => {
    expect(
      AgentReachSchema.safeParse({ moduleCount: 10, files: { "a.ts": 1 } })
        .success,
    ).toBe(true);
  });

  it("should reject files supplied without moduleCount", () => {
    // The whole point of the nested object: reach numbers are meaningless
    // without the universe they were measured against.
    expect(AgentReachSchema.safeParse({ files: { "a.ts": 5 } }).success).toBe(
      false,
    );
  });

  it("should reject moduleCount of 0", () => {
    expect(
      AgentReachSchema.safeParse({ moduleCount: 0, files: {} }).success,
    ).toBe(false);
  });

  it("should reject a negative moduleCount", () => {
    expect(
      AgentReachSchema.safeParse({ moduleCount: -1, files: {} }).success,
    ).toBe(false);
  });

  it("should reject a negative reach value", () => {
    expect(
      AgentReachSchema.safeParse({ moduleCount: 10, files: { "a.ts": -1 } })
        .success,
    ).toBe(false);
  });

  it("should reject a non-integer reach value", () => {
    expect(
      AgentReachSchema.safeParse({ moduleCount: 10, files: { "a.ts": 1.5 } })
        .success,
    ).toBe(false);
  });

  it("should reject a files value greater than moduleCount", () => {
    // A reach exceeding the universe size proves the two numbers came from
    // different metrics (e.g. a symbol count against a module count).
    const parsed = AgentReachSchema.safeParse({
      moduleCount: 10,
      files: { "a.ts": 11 },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("different metrics");
  });
});

// --- Path relevance ---

describe("isReachRelevantPath", () => {
  it("should treat .ts, .tsx and .js as reach-relevant", () => {
    expect(isReachRelevantPath("src/a.ts")).toBe(true);
    expect(isReachRelevantPath("src/a.tsx")).toBe(true);
    expect(isReachRelevantPath("src/a.js")).toBe(true);
  });

  it("should treat docs and data files as irrelevant", () => {
    expect(isReachRelevantPath("README.md")).toBe(false);
    expect(isReachRelevantPath("package.json")).toBe(false);
  });
});

// --- resolveReach: precedence ---

describe("resolveReach precedence", () => {
  const base = {
    project: "/p",
    changedRelPaths: ["src/a.ts"],
    fallbackModuleCount: 100,
  };

  it("should defer entirely to the built-in resolver when nothing is supplied", async () => {
    const r = ok(await resolveReach(base));
    expect(r.overrides.size).toBe(0);
    expect(r.moduleCount).toBe(100);
    expect(r.attribution).toEqual([]);
  });

  it("should use a provider when one is supplied", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        provider: {
          reachOf: (p) => (p === "src/a.ts" ? 40 : null),
          moduleCount: () => 200,
        },
      }),
    );
    expect(r.overrides.get("src/a.ts")).toBe(40);
    expect(r.moduleCount).toBe(200);
  });

  it("should tolerate a throwing provider without failing", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        provider: {
          reachOf: () => {
            throw new Error("external graph unavailable");
          },
          moduleCount: () => {
            throw new Error("nope");
          },
        },
      }),
    );
    expect(r.overrides.size).toBe(0);
    expect(r.moduleCount).toBe(100);
  });

  it("should ignore a provider reach that is negative or non-finite", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        provider: { reachOf: () => -5 },
      }),
    );
    expect(r.overrides.size).toBe(0);
  });

  it("should ignore a provider moduleCount that is not positive", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        provider: { reachOf: () => null, moduleCount: () => 0 },
      }),
    );
    expect(r.moduleCount).toBe(100);
  });

  it("should rank agent reach above a supplied ReachProvider", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: { moduleCount: 500, files: { "src/a.ts": 250 } },
        provider: { reachOf: () => 40, moduleCount: () => 200 },
      }),
    );
    expect(r.overrides.get("src/a.ts")).toBe(250);
    expect(r.moduleCount).toBe(500);
  });

  it("should never consult the provider once agent reach is accepted", async () => {
    let asked = 0;
    await resolveReach({
      ...base,
      agentReach: { moduleCount: 500, files: { "src/a.ts": 250 } },
      provider: {
        reachOf: () => {
          asked++;
          return 40;
        },
      },
    });
    expect(asked).toBe(0);
  });
});

// --- resolveReach: all-or-nothing coverage ---

describe("resolveReach all-or-nothing coverage", () => {
  const base = { project: "/p", fallbackModuleCount: 100 };

  it("should reject when a changed TS file is absent from files, naming it", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "src/b.ts"],
        agentReach: { moduleCount: 500, files: { "src/a.ts": 10 } },
      }),
    );
    expect(r.error).toContain("src/b.ts");
    expect(r.error).toContain("reach");
    // Must not silently degrade to the built-in resolver for the missing one.
    expect(r.error).toContain("1 of 2");
  });

  it("should accept when the only uncovered file is not TS/JS", async () => {
    // impact.ts short-circuits non-TS files with importerCount 0 and never
    // consults reach for them; requiring coverage would reject every
    // changeset containing a .md.
    const r = ok(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "README.md", "package.json"],
        agentReach: { moduleCount: 500, files: { "src/a.ts": 10 } },
      }),
    );
    expect(r.overrides.get("src/a.ts")).toBe(10);
    expect(r.overrides.has("README.md")).toBe(false);
  });

  it("should accept a changeset with no TS files at all", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        changedRelPaths: ["README.md"],
        agentReach: { moduleCount: 500, files: {} },
      }),
    );
    expect(r.moduleCount).toBe(500);
  });

  it("should name an unmatched absolute-path key rather than silently falling back", async () => {
    // Reach map keys are relative paths from `git diff --name-only`. An
    // absolute key simply will not match — this is the diagnostic that
    // surfaces the mistake.
    const abs = "/Users/x/proj/src/a.ts";
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: { moduleCount: 500, files: { [abs]: 10 } },
      }),
    );
    expect(r.error).toContain(abs);
    expect(r.error).toContain("src/a.ts");
    expect(r.error).toContain("repo-relative");
  });

  it("should reject defensively when moduleCount is not positive", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: { moduleCount: 0, files: { "src/a.ts": 0 } },
      }),
    );
    expect(r.error).toContain("moduleCount");
  });

  it("should reject defensively when a value exceeds moduleCount", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: { moduleCount: 10, files: { "src/a.ts": 11 } },
      }),
    );
    expect(r.error).toContain("src/a.ts");
    expect(r.error).toContain("11");
    expect(r.error).toContain("10");
  });

  it("should reject defensively when a value is negative", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: { moduleCount: 10, files: { "src/a.ts": -1 } },
      }),
    );
    expect(r.error).toContain("src/a.ts");
  });

  it("should not treat inherited object keys as coverage", async () => {
    const files = Object.create({ "src/a.ts": 5 }) as Record<string, number>;
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: { moduleCount: 10, files },
      }),
    );
    expect(r.error).toContain("src/a.ts");
  });
});

// --- resolveReach: attribution ---

describe("resolveReach attribution", () => {
  it("should report coverage and the source when supplied", async () => {
    const agentReach: AgentReach = {
      moduleCount: 500,
      files: { "src/a.ts": 250, "src/b.ts": 3 },
      source: "codebase-memory-mcp trace_path",
    };
    const r = ok(
      await resolveReach({
        project: "/p",
        changedRelPaths: ["src/a.ts", "src/b.ts", "README.md"],
        fallbackModuleCount: 100,
        agentReach,
      }),
    );
    const joined = r.attribution.join("\n");
    expect(joined).toContain("2 of 2");
    expect(joined).toContain("500");
    expect(joined).toContain("codebase-memory-mcp trace_path");
  });

  it("should report coverage without a source line when none is given", async () => {
    const r = ok(
      await resolveReach({
        project: "/p",
        changedRelPaths: ["src/a.ts"],
        fallbackModuleCount: 100,
        agentReach: { moduleCount: 500, files: { "src/a.ts": 250 } },
      }),
    );
    const joined = r.attribution.join("\n");
    expect(joined).toContain("1 of 1");
    expect(joined).not.toContain("Reach source");
  });
});
