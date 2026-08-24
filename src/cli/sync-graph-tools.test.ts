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

    it(`${target}: the block defers to the shipped mcp-servers.md contract`, () => {
      expect(phase7).toContain("`mcp-servers.md`");
    });

    it(`${target}: re-runs replace between the markers rather than append`, () => {
      expect(phase7).toContain("replace everything between them");
      expect(phase7).toContain("Exactly one block per file");
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
   */
  const SCHEMA_FIELDS = Object.keys(AgentReachSchema.shape).sort();

  it("AgentReachSchema declares exactly the fields the prose documents", () => {
    expect(
      SCHEMA_FIELDS,
      "AgentReachSchema's fields changed. Every shipped instruction naming " +
        "these — targets/*/commands/sync.md and targets/*/rules/mcp-servers.md " +
        "— must be updated in the same commit.",
    ).toEqual(["files", "moduleCount", "source"]);
  });

  // The `reach` wrapper itself is not a key of this object — it is the
  // parameter name on `impact_analysis`. That it survives the zod->JSON-Schema
  // converter into the advertised `inputSchema` is pinned separately, by
  // src/analysis/impact.test.ts ("advertised inputSchema").

  /** JSON object keys in a code sample, e.g. `"moduleCount":`. */
  function jsonKeys(text: string): string[] {
    return [...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)":/g)].map((m) => m[1]);
  }

  const sources: Array<[string, string]> = [
    ...TARGETS.map(
      (t) =>
        [
          `${t}/commands/sync.md wiring block`,
          (() => {
            const c = syncMd(t);
            return c.slice(
              c.indexOf(BEGIN_MARKER),
              c.indexOf(END_MARKER) + END_MARKER.length,
            );
          })(),
        ] as [string, string],
    ),
    ...TARGETS.map(
      (t) =>
        [
          `${t}/rules/mcp-servers.md`,
          (() => {
            const c = readFileSync(
              join(REPO_ROOT, "targets", t, "rules", "mcp-servers.md"),
              "utf-8",
            );
            return c.slice(c.indexOf("## Code-Graph Reach"));
          })(),
        ] as [string, string],
    ),
  ];

  for (const [label, text] of sources) {
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
