/**
 * Content tests for `/sync`'s MCP-server discovery and graph-tool wiring prose.
 *
 * `/sync` is a pure LLM prompt — nothing in `src/` executes it — so the only
 * thing standing between a typo and a shipped instruction is this file.
 *
 * ⚠️ Every OTHER check on this prose proves **symmetry**, not correctness:
 * `target-parity.test.ts` compares the two targets against a recorded diff, and
 * a symmetric typo passes it unchanged. These assertions are the correctness
 * half — they pin the facts Phase 7 has to state, and they cross-check every
 * parameter name the prose tells an agent to send against the real zod schema
 * in `src/analysis/reach.ts`.
 *
 * The bug this guards against having reappeared: Phase 7 named only `.mcp.json`
 * — a Claude Code file — in a region that is byte-identical across both
 * targets, so the OpenCode copy instructed the agent to parse a file OpenCode
 * never reads and always fell through to its own "skip" branch.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentReachSchema } from "../analysis/reach.js";
import {
  CallSiteSchema,
  ReachSourceSchema,
} from "../analysis/reach-sources.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const TARGETS = ["claude-code", "opencode"] as const;

const BEGIN_MARKER =
  "<!-- SENTINAL GRAPH TOOLS: BEGIN (managed by /sync — edits inside are overwritten) -->";
const END_MARKER = "<!-- SENTINAL GRAPH TOOLS: END -->";

function syncMd(target: string): string {
  return readFileSync(
    join(REPO_ROOT, "targets", target, "commands", "sync.md"),
    "utf-8",
  );
}

function mcpServersMd(target: string): string {
  return readFileSync(
    join(REPO_ROOT, "targets", target, "rules", "mcp-servers.md"),
    "utf-8",
  );
}

/** The managed block `/sync` writes, marker to marker inclusive. */
function graphToolsBlock(target: string): string {
  const c = syncMd(target);
  const from = c.indexOf(BEGIN_MARKER);
  expect(from, `${target}: BEGIN marker not found`).toBeGreaterThan(-1);
  return c.slice(from, c.indexOf(END_MARKER) + END_MARKER.length);
}

/** The reach contract in the shipped rule. Runs to end of file. */
function codeGraphReachSection(target: string): string {
  const c = mcpServersMd(target);
  const from = c.indexOf("## Code-Graph Reach");
  expect(from, `${target}: "## Code-Graph Reach" not found`).toBeGreaterThan(
    -1,
  );
  return c.slice(from);
}

/**
 * Every shipped surface that spells out a `reach` payload for an agent.
 *
 * Both are load-bearing and neither implies the other: `mcp-servers.md` is the
 * contract an agent reads, `sync.md`'s block is the recipe an agent *copies*.
 * Task 5 changed the schema and had to update both; a check that covered only
 * one would have let the other ship a shape the schema rejects.
 */
const PROSE_SOURCES: Array<[label: string, text: string]> = [
  ...TARGETS.map(
    (t) =>
      [`${t}/commands/sync.md wiring block`, graphToolsBlock(t)] as [
        string,
        string,
      ],
  ),
  ...TARGETS.map(
    (t) =>
      [
        `${t}/rules/mcp-servers.md Code-Graph Reach`,
        codeGraphReachSection(t),
      ] as [string, string],
  ),
];

/** Text from one `## ` heading up to the next named one. */
function section(content: string, start: string, end: string): string {
  const from = content.indexOf(start);
  expect(from, `heading not found: ${start}`).toBeGreaterThan(-1);
  const to = content.indexOf(end, from);
  expect(to, `heading not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return content.slice(from, to);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("/sync Phase 7 — MCP discovery covers both targets at both scopes", () => {
  // Mirrors `defaultMcpConfigPaths()` in src/cli/commands/install-prereqs.ts,
  // which is the canonical enumeration the prose must not drift from.
  const REQUIRED_TOKENS = [
    ".mcp.json", // Claude Code, project
    "~/.claude.json", // Claude Code, user
    "~/.claude/settings.json", // Claude Code, user
    "opencode.json", // OpenCode, project
    ".opencode/opencode.json", // OpenCode, project (alt)
    "$XDG_CONFIG_HOME", // OpenCode, user
    "`mcpServers`", // Claude Code key shape
    "(`mcp` key)", // OpenCode key shape
  ];

  for (const target of TARGETS) {
    const phase7 = section(
      syncMd(target),
      "## Phase 7: Sync MCP Rules",
      "## Phase 8:",
    );

    for (const token of REQUIRED_TOKENS) {
      it(`${target}: Phase 7 names ${token}`, () => {
        expect(
          phase7,
          `${target} sync.md Phase 7 is missing "${token}" — an agent following ` +
            `it will not find MCP servers configured there.`,
        ).toContain(token);
      });
    }

    it(`${target}: Phase 7 warns against reading ~/.claude.json whole`, () => {
      expect(phase7).toContain("never read that file whole");
    });

    it(`${target}: Phase 7 labels user-scope servers in the Source template`, () => {
      expect(
        phase7,
        `${target}: an unlabelled user-global server in a committed rule file ` +
          `is a false promise to teammates.`,
      ).toContain("(user-global — may not be present for teammates)");
    });
  }

  it("the Phase 7 region is identical across both targets", () => {
    const [cc, oc] = TARGETS.map((t) =>
      section(syncMd(t), "## Phase 7: Sync MCP Rules", "## Phase 8:"),
    );
    expect(
      cc,
      "Phase 7 diverged between targets — the edit was applied one-sidedly.",
    ).toBe(oc);
  });
});

describe("/sync Phase 7 — graph-tool wiring block", () => {
  for (const target of TARGETS) {
    const content = syncMd(target);
    const phase7 = section(
      content,
      "## Phase 7: Sync MCP Rules",
      "## Phase 8:",
    );

    it(`${target}: both markers appear exactly once, in order`, () => {
      expect(count(content, BEGIN_MARKER)).toBe(1);
      expect(count(content, END_MARKER)).toBe(1);
      expect(content.indexOf(BEGIN_MARKER)).toBeLessThan(
        content.indexOf(END_MARKER),
      );
      expect(phase7).toContain(BEGIN_MARKER);
      expect(phase7).toContain(END_MARKER);
    });

    it(`${target}: the block is omitted when the universe size is unknown`, () => {
      // Phase 6.5's lesson: a guessed value manufactures a false alarm on
      // every run. Omission is the fail-safe.
      expect(
        phase7,
        `${target}: without this, a guessed moduleCount produces a false HIGH ` +
          `on every change.`,
      ).toContain(
        "only if the universe size (`moduleCount`) is obtainable from the detected tool",
      );
    });

    it(`${target}: the block demands full coverage of changed TS files`, () => {
      // Consistent with the all-or-nothing rejection in src/analysis/reach.ts.
      expect(phase7).toContain(
        "collect reach for **every** changed `.ts`/`.tsx`/`.js` file",
      );
      expect(phase7).toContain("A partial `files` map is rejected outright");
    });

    it(`${target}: the capability table covers every catalogued row`, () => {
      // Task 6 widened the table beyond reach. Each row answers a different
      // question, and a missing row means the agent never learns the project
      // can answer it: universe size without per-file reach cannot produce a
      // share, and call sites are what make a HIGH actionable.
      const ROWS = [
        "Total modules in the graph (universe size)",
        "Modules transitively reaching a given file",
        "Call sites with file + line",
        "Symbol search by name",
        "Cross-repo / cross-service linking",
      ];
      const block = graphToolsBlock(target);
      for (const row of ROWS) {
        expect(
          block,
          `${target}: the capability table is missing the "${row}" row.`,
        ).toContain(row);
      }
      expect(
        block,
        `${target}: the table must record the invocation that was verified, ` +
          `so it needs a column for it.`,
      ).toContain("Verified invocation");
    });

    it(`${target}: the block defers to the shipped mcp-servers.md contract`, () => {
      expect(phase7).toContain("`mcp-servers.md`");
    });

    it(`${target}: re-runs replace between the markers rather than append`, () => {
      expect(phase7).toContain("replace everything between them");
      expect(phase7).toContain("Exactly one block per file");
    });

    it(`${target}: cross-repo is catalogued as unverified and never scored`, () => {
      // One project indexed; `cross_service` returned output byte-identical to
      // single-repo mode with no empty-result marker. Recording it is fine;
      // scoring from it is not.
      expect(phase7).toContain("⚠️ unverified — never score from it");
      expect(phase7).toContain("Keep it out of every `reach` payload");
    });

    it(`${target}: cautions that the obvious tool is not always the sound one`, () => {
      expect(
        phase7,
        `${target}: Step 7.2 smoke-tests every tool, so the block must record ` +
          `what actually returned correct data — a purpose-built tool can ` +
          `return aggregates or collide on a short symbol name.`,
      ).toContain(
        "Catalogue the invocation that was VERIFIED, not the obvious one",
      );
    });

    it(`${target}: states the generated block may be vendor-specific`, () => {
      // Without this, a future reader "fixes" the generated block to match the
      // vendor-neutral shipped rules and destroys the only concrete recipe.
      expect(phase7).toContain("This block SHOULD be vendor-specific");
      expect(phase7).toContain("is never shipped");
    });

    it(`${target}: names no vendor or product`, () => {
      // The generated block may name vendors; this shipped prose may not.
      // Mirrors the scrub recorded for src/analysis/reach.ts.
      for (const vendor of ["codebase-memory", "Codebase Memory", "serena"]) {
        expect(
          phase7.toLowerCase(),
          `${target}: shipped /sync prose must stay vendor-neutral.`,
        ).not.toContain(vendor.toLowerCase());
      }
    });

    it(`${target}: the plan_impact recipe says overlap needs no injected reach`, () => {
      expect(phase7).toContain("`plan_impact(project=");
      expect(
        phase7,
        `${target}: the wave-overlap half is deterministic on plan text — an ` +
          `agent that thinks it needs a graph server will never call it.`,
      ).toContain("needs **no** injected reach");
    });

    it(`${target}: the single-source form is still shown as valid`, () => {
      expect(
        phase7,
        `${target}: D2 keeps the single-object form accepted — implying it is ` +
          `broken would churn every already-working setup.`,
      ).toContain("The single-source form is still accepted unchanged");
    });
  }
});

/**
 * The emitted recipe is an instruction an agent copies verbatim, so a key that
 * the schema rejects ships as a guaranteed runtime failure. The sibling
 * `jsonKeys` guard below proves every key is *known*; this one proves the whole
 * payload actually **parses**, which is what catches a structural drift (a
 * `sources` entry hoisted to the top level, say) that a key-set check cannot.
 */
describe("the emitted reach payloads parse against the real schema", () => {
  /** Every `reach={...}` object, brace-matched (the payloads nest). */
  function extractReachObjects(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/reach=\{/g)) {
      const start = (m.index ?? 0) + "reach=".length;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    return out;
  }

  /** `<total>`/`<n>`/`, ...` are documentation placeholders, not values. */
  function realise(json: string): string {
    return json
      .replace(/<total>/g, "334")
      .replace(/<n>/g, "89")
      .replace(/,\s*\.\.\./g, "");
  }

  for (const [label, text] of PROSE_SOURCES) {
    const payloads = extractReachObjects(text).map(realise);

    it(`${label}: both documented shapes are present`, () => {
      expect(
        payloads.length,
        `${label}: expected the multi-source and single-source recipes.`,
      ).toBeGreaterThanOrEqual(2);
      const parsed = payloads.map((p) => JSON.parse(p));
      expect(
        parsed.some((p) => "sources" in p),
        `${label}: no multi-source example — the shape Task 5 introduced is ` +
          `undocumented here.`,
      ).toBe(true);
      expect(
        parsed.some((p) => !("sources" in p) && "moduleCount" in p),
        `${label}: no single-source example — D2 keeps that form valid and ` +
          `dropping it from the prose implies it was removed.`,
      ).toBe(true);
      expect(
        parsed.some((p) => "callSites" in p),
        `${label}: no callSites example.`,
      ).toBe(true);
    });

    it(`${label}: every documented payload is accepted by AgentReachSchema`, () => {
      for (const payload of payloads) {
        const result = AgentReachSchema.safeParse(JSON.parse(payload));
        expect(
          result.success ? null : JSON.stringify(result.error.issues),
          `${label} documents a payload the schema rejects — an agent copying ` +
            `it gets a hard error. Payload: ${payload}`,
        ).toBeNull();
      }
    });
  }
});

/**
 * The parse guard above is satisfied by *any* payload of each shape, so
 * deleting the dedicated single-source example would still leave the callSites
 * example — which happens to use that shape — carrying it. These assertions pin
 * the sections themselves, which is what D2's back-compat promise is written in.
 */
describe("mcp-servers.md documents both reach forms as currently valid", () => {
  for (const target of TARGETS) {
    it(`${target}: both form headings are present`, () => {
      const section = codeGraphReachSection(target);
      expect(section).toContain("#### Multi-source form");
      expect(section).toContain("#### Single-source form");
    });

    it(`${target}: the single-source form is stated to be unchanged`, () => {
      expect(
        codeGraphReachSection(target),
        `${target}: D2 keeps the single-object form valid. Prose that stops ` +
          `saying so reads as a removal, and every agent already sending it ` +
          `would migrate off a shape that never broke.`,
      ).toContain("**Still accepted, unchanged.**");
    });

    it(`${target}: exactly-one-source-is-scored is stated`, () => {
      expect(
        codeGraphReachSection(target),
        `${target}: D1. Without this an agent assumes supplying more sources ` +
          `sharpens the verdict, when it only adds attribution.`,
      ).toContain("Exactly one source is scored");
      expect(codeGraphReachSection(target)).toContain(
        "never scored", // callSites are evidence only
      );
    });
  }
});

describe("/sync Phase 11 and Phase 12 — backstop and reporting", () => {
  const PHASE_12_STATES = [
    "wired <names>",
    "detected but universe size unknown (block omitted)",
    "none detected",
  ];

  for (const target of TARGETS) {
    const content = syncMd(target);

    it(`${target}: Phase 11 cross-checks the block`, () => {
      const phase11 = section(
        content,
        "## Phase 11: Cross-Check",
        "## Phase 12:",
      );
      expect(phase11).toContain("SENTINAL GRAPH TOOLS");
      expect(
        phase11,
        `${target}: marker compliance in an LLM prompt is advisory, so the ` +
          `one-block check is the only backstop against a duplicated block.`,
      ).toContain("**exactly one**");
    });

    it(`${target}: Phase 12 reports all three graph-tool states`, () => {
      const phase12 = content.slice(content.indexOf("## Phase 12: Summary"));
      expect(phase12).toContain("- Graph tools:");
      for (const state of PHASE_12_STATES) {
        expect(
          phase12,
          `${target}: Phase 12 missing the "${state}" state — "detected but ` +
            `omitted" is informative, not a failure, and must be distinguishable.`,
        ).toContain(state);
      }
    });
  }
});

describe("prose parameter names exist in the real schema", () => {
  /**
   * Bound to the **schema**, not to `reach.ts`'s source text.
   *
   * The earlier form of this guard did `reachSrc.includes(param)` over the
   * whole file. `reach.ts` names `moduleCount`, `files` and `source` dozens of
   * times in doc comments and in the rejection-message builder, so renaming a
   * zod field would have left every one of those prose mentions — and this
   * test — green while the shipped instructions went wrong. It could not fail
   * for the reason it exists.
   *
   * In zod 4 `.refine()` returns the `ZodObject` itself, so `.shape` is the
   * live, declared key set.
   *
   * The nested shapes are pulled in the same way rather than being listed by
   * hand: a documented example payload spells out the keys of a `sources[]`
   * entry and of a `callSites[]` entry, and those are just as capable of
   * drifting from the schema as the top-level ones.
   */
  const TOP_FIELDS = Object.keys(AgentReachSchema.shape).sort();
  const SCHEMA_FIELDS = [
    ...new Set([
      ...TOP_FIELDS,
      ...Object.keys(ReachSourceSchema.shape),
      ...Object.keys(CallSiteSchema.shape),
    ]),
  ].sort();

  it("AgentReachSchema declares exactly the fields the prose documents", () => {
    expect(
      TOP_FIELDS,
      "AgentReachSchema's fields changed. Every shipped instruction naming " +
        "these — targets/*/commands/sync.md and targets/*/rules/mcp-servers.md " +
        "— must be updated in the same commit.",
    ).toEqual(["callSites", "files", "moduleCount", "source", "sources"]);
  });

  it("the nested source and call-site shapes are what the prose documents", () => {
    expect(Object.keys(ReachSourceSchema.shape).sort()).toEqual([
      "files",
      "moduleCount",
      "primary",
      "source",
    ]);
    expect(Object.keys(CallSiteSchema.shape).sort()).toEqual([
      "callee",
      "caller",
      "file",
      "line",
      "target",
    ]);
  });

  // The `reach` wrapper itself is not a key of this object — it is the
  // parameter name on `impact_analysis`. That it survives the zod->JSON-Schema
  // converter into the advertised `inputSchema` is pinned separately, by
  // src/analysis/impact.test.ts ("advertised inputSchema").

  /** JSON object keys in a code sample, e.g. `"moduleCount":`. */
  function jsonKeys(text: string): string[] {
    return [...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)":/g)].map((m) => m[1]);
  }

  for (const [label, text] of PROSE_SOURCES) {
    it(`${label} names no parameter absent from AgentReachSchema`, () => {
      const keys = [...new Set(jsonKeys(text))];
      expect(
        keys.length,
        `${label}: no JSON keys found — slice is wrong`,
      ).toBeGreaterThan(0);
      const unknown = keys.filter((k) => !SCHEMA_FIELDS.includes(k));
      expect(
        unknown,
        `${label} documents parameter(s) ${JSON.stringify(unknown)} that are ` +
          `not fields of AgentReachSchema (${SCHEMA_FIELDS.join(", ")}).`,
      ).toEqual([]);
    });
  }
});
