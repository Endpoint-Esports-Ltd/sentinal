/**
 * Content tests for the workflow prose that *consumes* the code-exploration
 * catalogue: `spec-plan`, `spec-implement`, and `lsp-tools.md`.
 *
 * Sibling of `sync-graph-tools.test.ts`, which owns the prose that *produces*
 * the catalogue and the `reach` payload contract. The split follows the files:
 * that one reads `sync.md` + `mcp-servers.md`, this one reads the two
 * `spec-plan` copies, the two `spec-implement` copies and the two
 * `lsp-tools.md` copies.
 *
 * ⚠️ As there, every other check on these files proves **symmetry**:
 * `target-parity.test.ts` compares each Claude Code file against its OpenCode
 * counterpart via a recorded diff, so a mistake made identically in both copies
 * passes it unchanged. These assertions are the correctness half.
 *
 * ⛔ Nothing here asserts that a target *lacks* an LSP tool. Both ship one —
 * Claude Code 2.1.205 registers it as `LSP`, OpenCode 1.18.23 as `lsp`, with
 * the same nine operations and the same parameter shape, verified against the
 * installed binaries. The casing divergence in `lsp-tools.md` is therefore
 * correct and deliberate, which is why that file is deliberately absent from
 * `IDENTICAL_RULES` (see the comment at `target-parity.test.ts`). What IS
 * pinned below is the parameter contract both runtimes really enforce.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const TARGETS = ["claude-code", "opencode"] as const;
type Target = (typeof TARGETS)[number];

/** The marker `/sync` writes; workflow prose must point at it by this name. */
const CATALOGUE_MARKER = "SENTINAL GRAPH TOOLS";

function read(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf-8");
}

/**
 * Claude Code ships these as commands; OpenCode ships them as skills.
 * The paths differ, the prose does not.
 */
function workflowDoc(target: Target, name: string): string {
  return target === "claude-code"
    ? read("targets", "claude-code", "commands", `${name}.md`)
    : read("targets", "opencode", "skills", name, "SKILL.md");
}

function lspToolsMd(target: Target): string {
  return read("targets", target, "rules", "lsp-tools.md");
}

/** The runtime's own name for its LSP tool. Both ship one; only case differs. */
const LSP_TOOL: Record<Target, string> = {
  "claude-code": "LSP(",
  opencode: "lsp(",
};

/** Text from `start` up to `end`, asserting both markers exist. */
function slice(content: string, start: string, end: string): string {
  const from = content.indexOf(start);
  expect(from, `marker not found: ${start}`).toBeGreaterThan(-1);
  const to = content.indexOf(end, from);
  expect(to, `marker not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return content.slice(from, to);
}

describe("spec-plan consults the catalogue and calls plan_impact", () => {
  for (const target of TARGETS) {
    const doc = workflowDoc(target, "spec-plan");

    it(`${target}: calls plan_impact with the plan path`, () => {
      expect(
        doc,
        `${target}: Step 1.5.0 item 2 states the same-wave overlap rule and ` +
          `nothing enforces it. Without this call it stays unenforced.`,
      ).toContain("plan_impact(project=");
      expect(doc).toContain("plan_path=");
    });

    it(`${target}: points at the catalogue by its marker name`, () => {
      // The marker is the contract between /sync's output and this prose.
      // "look for the graph tools block" would not survive a rename.
      expect(
        doc,
        `${target}: spec-plan must name the block \`${CATALOGUE_MARKER}\` ` +
          `exactly, or an agent cannot find what /sync wrote.`,
      ).toContain(`\`${CATALOGUE_MARKER}\``);
      expect(doc).toContain(".sentinal/rules/{slug}-mcp-servers.md");
    });

    it(`${target}: injects a verified capability and refuses an unverified one`, () => {
      expect(
        doc,
        `${target}: cataloguing a capability is useless if the prose never ` +
          `says to pass it to the tool.`,
      ).toContain("pass it in the `reach` parameter");
      expect(doc).toContain("✅ verified");
      expect(
        doc,
        `${target}: cross-repo linking is catalogued but unverified — ` +
          `scoring from it would launder a guess into a risk verdict.`,
      ).toContain("Never feed a row marked ⚠️ unverified into `reach`");
    });

    /**
     * `plan_impact` builds its coverage set as
     * `claimed.filter(f => f.exists && isReachRelevantPath(f.path))`
     * (`src/analysis/plan-impact.ts`) — keyed on `exists`, never on the verb,
     * and the scored source is rejected outright if it misses one entry.
     *
     * Prose that scopes collection to `Modify:` therefore instructs the agent
     * to build a payload the tool refuses: a path listed under `Create:` that
     * already exists is in the set, and the compact `**Files:** …` form used
     * by every bugfix plan states no verb at all, defaulting to `modify`.
     * That is the exact verb-vs-`exists` trap the plan's Wave-2 outcome
     * warned about.
     */
    it(`${target}: scopes reach collection by on-disk existence, not by verb`, () => {
      const step = slice(
        doc,
        "**Confirm the grouping with `plan_impact`",
        "#### Step 1.5.1",
      );
      expect(
        step,
        `${target}: the injection instruction must name the real coverage ` +
          `rule — every claimed file that already exists on disk, whatever ` +
          `verb it was listed under.`,
      ).toContain("already exists on disk, whatever verb it was listed under");
      expect(
        step,
        `${target}: state that coverage is keyed on existence so a reader ` +
          `cannot infer the verb still matters.`,
      ).toContain("keys coverage on on-disk existence, never on the verb");
      expect(
        /collect that data for the plan's existing `Modify:` targets/.test(
          step,
        ),
        `${target}: the instruction scopes reach collection to \`Modify:\` ` +
          `targets. plan_impact gates on \`exists\`, so an agent following ` +
          `this literally supplies an incomplete map and is rejected.`,
      ).toBe(false);
    });

    it(`${target}: calls plan_impact even with nothing catalogued`, () => {
      expect(
        doc,
        `${target}: the wave-overlap half is deterministic on plan text. An ` +
          `agent that believes it needs a graph server will never call it.`,
      ).toContain("call `plan_impact` anyway, with no `reach`");
    });

    it(`${target}: frames the result as advisory, not a gate`, () => {
      expect(doc).toContain("(advisory, not a gate)");
      expect(
        doc,
        `${target}: overlap detection fires on 3 of 89 verified plans and at ` +
          `least one was a deliberate, already-resolved conflict. Presented ` +
          `as a gate it would block correct plans.`,
      ).toContain("do not block on it");
      expect(doc).toContain(
        "a statement about the plan text, not proof of harm",
      );
    });

    it(`${target}: names the prediction bound on the reach half`, () => {
      expect(
        doc,
        `${target}: a plan's Files: list is a prediction. Presenting ` +
          `prospective reach with the same confidence as overlap detection ` +
          `overstates it.`,
      ).toContain("prediction bounded by how accurate the `Files:` lists");
    });
  }

  it("both copies carry the same plan_impact guidance", () => {
    const [cc, oc] = TARGETS.map((t) =>
      slice(
        workflowDoc(t, "spec-plan"),
        "**Confirm the grouping with `plan_impact`",
        "#### Step 1.5.1",
      ),
    );
    expect(
      cc,
      "the plan_impact guidance diverged between targets — the edit was " +
        "applied one-sidedly.",
    ).toBe(oc);
  });
});

describe("spec-implement orders caller-finding LSP -> catalogue -> grep", () => {
  const RUNGS = [
    "**LSP, where the runtime provides it**",
    "**A catalogued code-graph capability**",
    "**Grep, as a last resort**",
  ];

  for (const target of TARGETS) {
    const doc = workflowDoc(target, "spec-implement");
    const step = slice(
      doc,
      "**Call chain analysis:**",
      "**Pre-edit type check:**",
    );

    it(`${target}: all three rungs appear, in order`, () => {
      let previous = -1;
      for (const rung of RUNGS) {
        const at = step.indexOf(rung);
        expect(
          at,
          `${target}: the caller-finding step is missing the rung ` +
            `${rung}. All three exist because each fails differently.`,
        ).toBeGreaterThan(-1);
        expect(
          at,
          `${target}: ${rung} is out of order — the ordering IS the ` +
            `instruction; grep listed first makes the other two dead prose.`,
        ).toBeGreaterThan(previous);
        previous = at;
      }
    });

    it(`${target}: describes grep as a lower bound`, () => {
      expect(
        step,
        `${target}: without this an agent concludes "nothing calls this" from ` +
          `a grep miss and deletes a live symbol. Grep matches text, not ` +
          `symbols, so a miss is not evidence of absence.`,
      ).toContain("lower bound");
      expect(step).toContain('never conclude "nothing calls this"');
    });

    it(`${target}: reaches the catalogue by its marker name`, () => {
      expect(
        step,
        `${target}: rung 2 is unusable unless it says where the catalogue is.`,
      ).toContain(`\`${CATALOGUE_MARKER}\``);
      expect(step).toContain(".sentinal/rules/{slug}-mcp-servers.md");
    });

    it(`${target}: names no vendor in the ordering`, () => {
      // The generated catalogue may name a vendor; it is written per-project
      // from smoke-testing. This prose ships to every project and may not.
      for (const vendor of ["codebase-memory", "serena"]) {
        expect(step.toLowerCase()).not.toContain(vendor);
      }
    });

    it(`${target}: spells the LSP tool the way this runtime registers it`, () => {
      // Both runtimes ship one; only the casing differs. Asserting the
      // target's OWN spelling is what byte-identity could not express.
      const own = LSP_TOOL[target];
      const other =
        LSP_TOOL[target === "claude-code" ? "opencode" : "claude-code"];
      expect(
        doc,
        `${target}: registers its LSP tool as \`${own.slice(0, -1)}\`.`,
      ).toContain(own);
      expect(
        doc.includes(other),
        `${target}: names \`${other.slice(0, -1)}\` — the OTHER runtime's ` +
          `spelling. That call is rejected before reaching a language server.`,
      ).toBe(false);
    });
  }
});

/**
 * Both runtimes validate `{filePath, line, character}` and reject `file:`.
 * Every example shipped before Task 9 used `file:` and would have failed.
 */
describe("shipped LSP examples use the parameter names both runtimes require", () => {
  const OPERATIONS = [
    "hover",
    "goToDefinition",
    "findReferences",
    "goToImplementation",
    "documentSymbol",
    "workspaceSymbol",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
  ];

  const DOCS: Array<[string, string]> = [
    ...TARGETS.map(
      (t) => [`${t}/rules/lsp-tools.md`, lspToolsMd(t)] as [string, string],
    ),
    ...TARGETS.map(
      (t) =>
        [`${t} spec-implement`, workflowDoc(t, "spec-implement")] as [
          string,
          string,
        ],
    ),
  ];

  for (const [label, doc] of DOCS) {
    it(`${label}: every LSP invocation passes filePath, line and character`, () => {
      const calls = [...doc.matchAll(/\b[Ll][Ss][Pp]\(\{([^}]*)\}\)/g)].map(
        (m) => m[1],
      );
      expect(
        calls.length,
        `${label}: no LSP invocations found — the slice or the regex is wrong.`,
      ).toBeGreaterThan(0);
      for (const args of calls) {
        expect(
          args,
          `${label}: an LSP call omits \`filePath\`. The parameter is ` +
            `\`filePath\`, never \`file\` — a call using \`file:\` is ` +
            `rejected before it reaches the language server.`,
        ).toContain("filePath:");
        expect(args, `${label}: an LSP call omits \`line\`.`).toContain(
          "line:",
        );
        expect(
          args,
          `${label}: an LSP call omits \`character\`. Both runtimes require ` +
            `it on EVERY operation, including documentSymbol/workspaceSymbol, ` +
            `which ignore the position but still validate it.`,
        ).toContain("character:");
        expect(
          /\bfile:/.test(args),
          `${label}: an LSP call still uses the old \`file:\` parameter.`,
        ).toBe(false);
      }
    });
  }

  for (const target of TARGETS) {
    it(`${target}/rules/lsp-tools.md documents all nine operations`, () => {
      const doc = lspToolsMd(target);
      for (const op of OPERATIONS) {
        expect(
          doc,
          `${target}: operation \`${op}\` is undocumented. Both runtimes ` +
            `expose the same nine.`,
        ).toContain(op);
      }
    });

    it(`${target}/rules/lsp-tools.md warns that the parameter is filePath, not file`, () => {
      expect(
        lspToolsMd(target),
        `${target}: the examples alone do not stop an agent that already ` +
          `believes the parameter is \`file\`.`,
      ).toContain("The path parameter is `filePath`, not `file`");
    });
  }
});

/**
 * Shipped prose is vendor-neutral; only the per-project block `/sync` generates
 * may name a vendor, and that block is never shipped.
 *
 * Kept as a repo-wide sweep rather than a per-file check because the failure
 * mode is a vendor name appearing somewhere nobody thought to look — which is
 * exactly what happened at `src/analysis/reach.ts:137`, where the name reached
 * every emitted `inputSchema`. Task 5 scrubbed it.
 */
describe("no shipped file names a code-exploration vendor", () => {
  const VENDORS = ["codebase-memory", "codebase memory", "serena"];

  function walk(dir: string, keep: (path: string) => boolean): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      if (keep(path)) out.push(path);
    }
    return out;
  }

  const SCANNED: Array<[string, string[]]> = [
    [
      "targets/**/*.md",
      walk(join(REPO_ROOT, "targets"), (p) => p.endsWith(".md")),
    ],
    [
      "src/**/*.ts (non-test)",
      walk(
        join(REPO_ROOT, "src"),
        (p) =>
          p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"),
      ),
    ],
  ];

  for (const [label, files] of SCANNED) {
    it(`${label} names no vendor`, () => {
      expect(
        files.length,
        `${label}: nothing was scanned — the walk is wrong, so this test ` +
          `would pass vacuously.`,
      ).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const file of files) {
        const lower = readFileSync(file, "utf-8").toLowerCase();
        for (const vendor of VENDORS) {
          if (lower.includes(vendor)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)} -> ${vendor}`);
          }
        }
      }
      expect(
        offenders,
        "Shipped files must depend on a *capability*, never a vendor. The " +
          "per-project block /sync generates is the only place a product name " +
          "belongs, and it is never shipped.",
      ).toEqual([]);
    });
  }
});
