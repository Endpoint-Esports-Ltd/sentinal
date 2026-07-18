/**
 * Shipped-rules memory-reference tests.
 *
 * Guards that shipped rules/commands reference the REAL Sentinal memory tools.
 * The rules previously documented a renamed/removed interface — `mem-search`,
 * `save_memory`, `get_observations`, `mcp__plugin_sentinal_mem-search__*`, and
 * observation types `bugfix/feature/refactor/change` — none of which exist in
 * src. The real interface is the `sentinal` MCP server with `memory_search`,
 * `memory_save`, `memory_get`, `memory_timeline`, `memory_stats`,
 * `memory_share` and types `decision/discovery/error/fix/pattern`.
 *
 * These docs ship into user projects and are always loaded, so a stale name
 * makes an agent call a tool that does not exist. This test prevents the
 * renamed interface (or any future rename drift) from reappearing.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const TARGETS = ["opencode", "claude-code"] as const;

// Unambiguous stale identifiers — safe to grep globally (these strings have no
// legitimate non-memory use). NOTE: we deliberately do NOT grep the observation
// type words (bugfix/feature/refactor/change) globally — they appear ~46 times
// in legitimate non-memory contexts (e.g. "OnPush change detection"). The stale
// type list is checked as a specific line in mcp-servers.md instead (below).
const STALE_IDENTIFIERS = [
  "mem-search",
  "save_memory",
  "get_observations",
  "mcp__plugin_sentinal_mem-search",
];

function rulesDir(target: string): string {
  return join(REPO_ROOT, "targets", target, "rules");
}
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isFile() && entry.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("shipped rules — no stale memory identifiers", () => {
  for (const target of TARGETS) {
    const files = [
      ...walkFiles(rulesDir(target)),
      join(REPO_ROOT, "targets", target, "commands", "sync.md"),
    ];
    for (const file of files) {
      it(`${file.replace(REPO_ROOT + "/", "")} has no stale memory identifiers`, () => {
        const content = readFileSync(file, "utf-8");
        const hits = STALE_IDENTIFIERS.filter((s) => content.includes(s));
        expect(
          hits,
          `${file}: stale memory identifiers ${JSON.stringify(hits)} — ` +
            `use memory_search/memory_save/memory_get/memory_timeline under the ` +
            `'sentinal' server instead.`,
        ).toEqual([]);
      });
    }
  }

  // Scoped observation-type check — only the known offender line, not a global
  // grep of the bare type words (which false-positive on legitimate prose).
  for (const target of TARGETS) {
    it(`${target}/rules/mcp-servers.md lists real observation types, not the stale set`, () => {
      const content = readFileSync(
        join(rulesDir(target), "mcp-servers.md"),
        "utf-8",
      );
      const typesLine = content
        .split("\n")
        .find((l) => /\*\*Types:\*\*/.test(l));
      if (typesLine) {
        expect(
          /refactor|\bchange\b/.test(typesLine),
          `mcp-servers.md **Types:** line still lists stale memory types ` +
            `(refactor/change) — real types are decision/discovery/error/fix/pattern.`,
        ).toBe(false);
      }
    });
  }
});

describe("shipped rules — recall cues present at decision points", () => {
  for (const target of TARGETS) {
    for (const name of ["research-tools.md", "development-practices.md"]) {
      it(`${target}/rules/${name} cues memory_search`, () => {
        const content = readFileSync(join(rulesDir(target), name), "utf-8");
        expect(content, `${name} missing memory_search cue`).toContain(
          "memory_search",
        );
      });
    }
  }
});

describe("delivery path — both embedded rule records reference real tools", () => {
  it("EMBEDDED_RULES and EMBEDDED_CC_RULES use memory_search, not mem-search", async () => {
    const { EMBEDDED_RULES, EMBEDDED_CC_RULES } =
      await import("./embedded-assets.js");
    const records: Array<[string, Record<string, string>]> = [
      ["EMBEDDED_RULES", EMBEDDED_RULES as Record<string, string>],
      ["EMBEDDED_CC_RULES", EMBEDDED_CC_RULES as Record<string, string>],
    ];
    for (const [label, rec] of records) {
      for (const key of ["mcp-servers.md", "research-tools.md"]) {
        const content = rec[key];
        expect(content, `${label} missing ${key}`).toBeDefined();
        expect(
          content.includes("memory_search"),
          `${label}[${key}] missing memory_search — run 'bun run embed-assets'`,
        ).toBe(true);
        expect(
          content.includes("mem-search"),
          `${label}[${key}] still contains stale 'mem-search'`,
        ).toBe(false);
      }
    }
  });
});
