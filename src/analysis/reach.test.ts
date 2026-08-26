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
  isHighReach,
  isMediumReach,
  isReachRelevantPath,
  resolveReach,
  type AgentReach,
} from "./reach.js";

/** LOW / MEDIUM / HIGH from a reach and the universe it was measured in. */
function verdict(reach: number, moduleCount: number): string {
  if (isHighReach(reach, moduleCount)) return "HIGH";
  if (isMediumReach(reach, moduleCount)) return "MEDIUM";
  return "LOW";
}

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
      source: "<server> <tool>",
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
      source: "module-graph trace",
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
    expect(joined).toContain("module-graph trace");
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

// --- Multi-source schema ---

/**
 * The two granularity models used throughout the multi-source tests.
 *
 * They are the exact pair from D1: measured on `src/runtime/ownership.ts`, a
 * module-level graph reports 89 of 334 modules (26.6% → HIGH) while a
 * symbol-level graph reports 200 of 8440 symbols (2.4% → LOW). Both are
 * internally valid; neither is convertible into the other. That is why exactly
 * one source may score.
 */
const MODULE_SOURCE = {
  source: "module-graph trace",
  moduleCount: 334,
  files: { "src/a.ts": 89 },
};
const SYMBOL_SOURCE = {
  source: "symbol-graph callers",
  moduleCount: 8440,
  files: { "src/a.ts": 200 },
};

describe("AgentReachSchema multi-source form", () => {
  it("should accept a sources array with per-source universes", () => {
    const parsed = AgentReachSchema.safeParse({
      sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
    });
    expect(parsed.success).toBe(true);
  });

  it("should still accept the single-object form (D2 back-compat)", () => {
    // ⛔ The currently-shipped `mcp-servers.md` documents this form. Dropping
    // it would break every agent following the rule the moment this lands.
    const parsed = AgentReachSchema.safeParse({
      moduleCount: 334,
      files: { "src/a.ts": 89 },
      source: "<server> <tool>",
    });
    expect(parsed.success).toBe(true);
  });

  it("should reject both forms supplied at once", () => {
    const parsed = AgentReachSchema.safeParse({
      sources: [MODULE_SOURCE],
      moduleCount: 334,
      files: { "src/a.ts": 89 },
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject an empty sources array", () => {
    expect(AgentReachSchema.safeParse({ sources: [] }).success).toBe(false);
  });

  it("should reject a source missing its own moduleCount", () => {
    expect(
      AgentReachSchema.safeParse({ sources: [{ files: { "src/a.ts": 1 } }] })
        .success,
    ).toBe(false);
  });

  it("should reject more than one source marked primary", () => {
    // Two primaries make the scored source depend on declaration order, which
    // is precisely the non-determinism D1 exists to remove.
    const parsed = AgentReachSchema.safeParse({
      sources: [
        { ...MODULE_SOURCE, primary: true },
        { ...SYMBOL_SOURCE, primary: true },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("primary");
  });

  it("should reject a top-level `primary` rather than silently stripping it", async () => {
    // ⛔ D1's last hole. Hoisting `primary` out of the entry is an easy slip —
    // the two documented shapes sit side by side in `mcp-servers.md`. Without
    // `.strict()` zod DROPS the unknown key, the `<= 1 primary` refinement
    // never sees it, `selectPrimaryIndex` finds no marking and falls through
    // to index 0, and the FIRST-DECLARED source produces the verdict. That is
    // a risk score decided by declaration order, and silently: the agent gets
    // a wrong answer with no indication its marking was discarded.
    const parsed = AgentReachSchema.safeParse({
      primary: true,
      sources: [MODULE_SOURCE, SYMBOL_SOURCE],
    });
    expect(
      parsed.success,
      "a mis-nested top-level `primary` was accepted — it is stripped, so " +
        "sources[0] scores and the agent's marking is silently ignored.",
    ).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("primary");

    // The harm made concrete: had it been stripped, index 0 would have scored
    // HIGH (89/334 = 26.6%), while the marking the agent actually wrote —
    // once nested where it belongs — yields the opposite verdict.
    const nested = ok(
      await resolveReach({
        project: "/p",
        changedRelPaths: ["src/a.ts"],
        fallbackModuleCount: 100,
        agentReach: {
          sources: [MODULE_SOURCE, { ...SYMBOL_SOURCE, primary: true }],
        },
      }),
    );
    expect(verdict(nested.overrides.get("src/a.ts")!, nested.moduleCount)).toBe(
      "LOW",
    );
    expect(
      verdict(MODULE_SOURCE.files["src/a.ts"], MODULE_SOURCE.moduleCount),
      "the two sources must disagree, or this test proves nothing.",
    ).toBe("HIGH");
  });

  it("should reject any unknown top-level key", () => {
    // Not just `primary`: an unknown key means the agent believes it is
    // sending something Sentinal reads, and it is not. Saying so beats
    // discarding it.
    expect(
      AgentReachSchema.safeParse({
        sources: [MODULE_SOURCE],
        callSitesX: [],
      }).success,
    ).toBe(false);
  });

  it("should reject a value exceeding its OWN source's moduleCount", () => {
    // 200 is fine against 8440 and impossible against 334 — the bound is
    // per-source, which is the whole point of per-source universes.
    const parsed = AgentReachSchema.safeParse({
      sources: [{ moduleCount: 334, files: { "src/a.ts": 8000 } }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("different metrics");
  });

  it("should accept call sites alongside either form", () => {
    const callSites = [
      {
        file: "src/caller.ts",
        line: 42,
        caller: "doWork",
        callee: "resolveReach",
        target: "src/a.ts",
      },
    ];
    expect(
      AgentReachSchema.safeParse({ sources: [MODULE_SOURCE], callSites })
        .success,
    ).toBe(true);
    expect(
      AgentReachSchema.safeParse({
        moduleCount: 334,
        files: { "src/a.ts": 89 },
        callSites,
      }).success,
    ).toBe(true);
  });

  it("should reject call sites without any reach", () => {
    expect(
      AgentReachSchema.safeParse({
        callSites: [
          {
            file: "src/caller.ts",
            line: 1,
            caller: "a",
            callee: "b",
            target: "src/a.ts",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

// --- D1: exactly one source scores ---

describe("resolveReach single-primary scoring (D1)", () => {
  const base = {
    project: "/p",
    changedRelPaths: ["src/a.ts"],
    fallbackModuleCount: 100,
  };

  it("should score the module source alone when it is primary, ignoring the symbol source", async () => {
    const withBoth = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
        },
      }),
    );
    expect(withBoth.moduleCount).toBe(334);
    expect(withBoth.overrides.get("src/a.ts")).toBe(89);
    expect(verdict(withBoth.overrides.get("src/a.ts")!, withBoth.moduleCount)) //
      .toBe("HIGH");
  });

  it("should return an identical verdict whether or not the non-primary source is present", async () => {
    // ⛔ The load-bearing assertion. If a second source could move the verdict,
    // the risk score for identical code would become a function of which
    // servers happen to be installed.
    const alone = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [{ ...MODULE_SOURCE, primary: true }] },
      }),
    );
    const withExtra = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
        },
      }),
    );

    expect(withExtra.moduleCount).toBe(alone.moduleCount);
    expect([...withExtra.overrides]).toEqual([...alone.overrides]);
    expect(
      verdict(withExtra.overrides.get("src/a.ts")!, withExtra.moduleCount),
    ).toBe(verdict(alone.overrides.get("src/a.ts")!, alone.moduleCount));
  });

  it("should flip the verdict only when the primary marking moves", async () => {
    const symbolPrimary = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [MODULE_SOURCE, { ...SYMBOL_SOURCE, primary: true }],
        },
      }),
    );
    expect(symbolPrimary.moduleCount).toBe(8440);
    expect(symbolPrimary.overrides.get("src/a.ts")).toBe(200);
    expect(
      verdict(
        symbolPrimary.overrides.get("src/a.ts")!,
        symbolPrimary.moduleCount,
      ),
      "the same file scores LOW in a symbol universe and HIGH in a module one — both valid, which is why only one may score",
    ).toBe("LOW");
  });

  it("should treat the FIRST source as primary when none is marked", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [SYMBOL_SOURCE, MODULE_SOURCE] },
      }),
    );
    expect(r.moduleCount).toBe(8440);
    expect(r.overrides.get("src/a.ts")).toBe(200);
  });

  it("should take neither the max nor the min across sources", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
        },
      }),
    );
    // max would be 200/8440, min would be 89/8440 or 89/334 depending on which
    // scalar you paired it with. Only the primary's own pair is used.
    expect(r.overrides.get("src/a.ts")).toBe(89);
    expect(r.moduleCount).toBe(334);
  });

  it("should normalise the single-object form to a one-element source list", async () => {
    const single = ok(
      await resolveReach({
        ...base,
        agentReach: { moduleCount: 334, files: { "src/a.ts": 89 } },
      }),
    );
    const asList = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ moduleCount: 334, files: { "src/a.ts": 89 } }],
        },
      }),
    );
    expect(single.moduleCount).toBe(asList.moduleCount);
    expect([...single.overrides]).toEqual([...asList.overrides]);
    expect(single.attribution).toEqual(asList.attribution);
  });
});

// --- Non-primary sources are rendered explicitly as unscored ---

describe("resolveReach non-primary attribution", () => {
  const base = {
    project: "/p",
    changedRelPaths: ["src/a.ts"],
    fallbackModuleCount: 100,
  };

  it("should name the primary as scored and every other source as unscored", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
        },
      }),
    );
    const joined = r.attribution.join("\n");

    expect(joined).toContain("module-graph trace");
    expect(joined).toContain("primary");
    expect(joined).toContain("symbol-graph callers");
    expect(
      joined,
      "a reader must be able to see at a glance that the second source did not contribute to the verdict",
    ).toContain("unscored");
    expect(joined).toContain("8440");
  });

  it("should say WHY only one source scores when more than one is supplied", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }, SYMBOL_SOURCE],
        },
      }),
    );
    expect(r.attribution.join("\n").toLowerCase()).toContain("commensurable");
  });

  it("should not emit unscored-source noise for a single source", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [MODULE_SOURCE] },
      }),
    );
    expect(r.attribution.join("\n")).not.toContain("unscored");
  });

  it("should label an unnamed non-primary source by its position", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [
            { moduleCount: 334, files: { "src/a.ts": 89 } },
            { moduleCount: 8440, files: { "src/a.ts": 200 } },
          ],
        },
      }),
    );
    expect(r.attribution.join("\n")).toContain("source 2");
  });
});

// --- Per-source coverage: one bad source must not poison the others ---

describe("resolveReach per-source coverage", () => {
  const base = { project: "/p", fallbackModuleCount: 100 };

  it("should drop a non-primary source that misses a changed TS file, naming it", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "src/b.ts"],
        agentReach: {
          sources: [
            {
              source: "module-graph trace",
              primary: true,
              moduleCount: 334,
              files: { "src/a.ts": 89, "src/b.ts": 2 },
            },
            {
              source: "symbol-graph callers",
              moduleCount: 8440,
              files: { "src/a.ts": 200 },
            },
          ],
        },
      }),
    );
    const joined = r.attribution.join("\n");

    // Rejected BY NAME...
    expect(joined).toContain("symbol-graph callers");
    expect(joined).toContain("src/b.ts");
    // ...without poisoning the primary, which still scores.
    expect(r.moduleCount).toBe(334);
    expect(r.overrides.get("src/a.ts")).toBe(89);
    expect(r.overrides.get("src/b.ts")).toBe(2);
  });

  it("should reject the whole call when the PRIMARY source misses a file, naming the source", async () => {
    // The primary is the only source that scores, so an incomplete primary
    // would measure the uncovered files' built-in counts against its universe —
    // the exact silent mis-scoring all-or-nothing exists to prevent.
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "src/b.ts"],
        agentReach: {
          sources: [
            {
              source: "module-graph trace",
              primary: true,
              moduleCount: 334,
              files: { "src/a.ts": 89 },
            },
            SYMBOL_SOURCE,
          ],
        },
      }),
    );
    expect(r.error).toContain("module-graph trace");
    expect(r.error).toContain("src/b.ts");
    expect(r.error).toContain("1 of 2");
  });

  it("should not blame the other sources when the primary is rejected", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "src/b.ts"],
        agentReach: {
          sources: [
            {
              source: "module-graph trace",
              primary: true,
              moduleCount: 334,
              files: { "src/a.ts": 89 },
            },
            {
              source: "symbol-graph callers",
              moduleCount: 8440,
              files: { "src/a.ts": 200, "src/b.ts": 4 },
            },
          ],
        },
      }),
    );
    expect(r.error).not.toContain("symbol-graph callers");
  });

  it("should still surface an unmatched absolute key for the failing source only", async () => {
    const abs = "/Users/x/proj/src/a.ts";
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts"],
        agentReach: {
          sources: [
            {
              source: "s1",
              primary: true,
              moduleCount: 334,
              files: { [abs]: 10 },
            },
          ],
        },
      }),
    );
    expect(r.error).toContain(abs);
    expect(r.error).toContain("repo-relative");
  });

  it("should reject when EVERY source fails, rather than reporting an empty result", async () => {
    const r = rejected(
      await resolveReach({
        ...base,
        changedRelPaths: ["src/a.ts", "src/b.ts"],
        agentReach: {
          sources: [
            { source: "s1", moduleCount: 334, files: { "src/a.ts": 89 } },
            { source: "s2", moduleCount: 8440, files: { "src/a.ts": 200 } },
          ],
        },
      }),
    );
    expect(r.error).toContain("s1");
  });
});

// --- Call sites are evidence only ---

describe("resolveReach call sites", () => {
  const base = {
    project: "/p",
    changedRelPaths: ["src/a.ts"],
    fallbackModuleCount: 100,
  };
  const callSites = [
    {
      file: "src/caller.ts",
      line: 42,
      caller: "doWork",
      callee: "resolveReach",
      target: "src/a.ts",
    },
  ];

  it("should surface supplied call sites on the resolution", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [MODULE_SOURCE], callSites },
      }),
    );
    expect(r.callSites).toEqual(callSites);
  });

  it("should leave the verdict untouched by call sites", async () => {
    // Everything `scoreRisk` can see from reach is `moduleCount` + `overrides`.
    // If those are identical, no call site can move the risk score.
    const without = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [{ ...MODULE_SOURCE, primary: true }] },
      }),
    );
    const withSites = ok(
      await resolveReach({
        ...base,
        agentReach: {
          sources: [{ ...MODULE_SOURCE, primary: true }],
          callSites,
        },
      }),
    );

    expect(withSites.moduleCount).toBe(without.moduleCount);
    expect([...withSites.overrides]).toEqual([...without.overrides]);
    expect(
      verdict(withSites.overrides.get("src/a.ts")!, withSites.moduleCount),
    ).toBe(verdict(without.overrides.get("src/a.ts")!, without.moduleCount));
  });

  it("should default call sites to an empty list", async () => {
    const r = ok(
      await resolveReach({
        ...base,
        agentReach: { sources: [MODULE_SOURCE] },
      }),
    );
    expect(r.callSites).toEqual([]);

    const builtIn = ok(await resolveReach(base));
    expect(builtIn.callSites).toEqual([]);
  });
});

// --- Constraints must reach the agent through `.describe()` ---

describe("AgentReachSchema describe text", () => {
  /**
   * ⛔ `.refine()` is dropped by the zod->JSON-Schema converter (pinned by
   * `impact.test.ts`'s "advertised inputSchema" block), so a refinement's
   * message NEVER reaches the agent. Every constraint therefore has to be
   * restated in `.describe()` prose, and this asserts it is.
   */
  const shape = AgentReachSchema.shape as Record<
    string,
    { description?: string }
  >;
  const allText = [
    AgentReachSchema.description ?? "",
    ...Object.values(shape).map((f) => f.description ?? ""),
  ]
    .join("\n")
    .toLowerCase();

  it.each([
    ["single-primary scoring", "primary"],
    ["only one source scores", "one source"],
    ["non-primary sources are unscored", "unscored"],
    ["per-source universes", "own universe"],
    ["all-or-nothing coverage", "every changed"],
    ["single-object back-compat", "single-source form"],
    ["call sites never score", "never scored"],
    ["repo-relative keys", "repo-relative"],
  ])("states the %s constraint in prose the agent receives", (_label, text) => {
    expect(allText).toContain(text);
  });
});
