/**
 * Cross-Target Content Parity Guard
 *
 * `targets/claude-code/commands/spec-<n>.md` and
 * `targets/opencode/skills/spec-<n>/SKILL.md` are BOTH canonical and are kept in
 * sync BY HAND — the generator was deliberately deleted and its absence is
 * asserted by `src/cli/commands/no-leak.test.ts`. Nothing previously caught a
 * one-sided edit, so a rewrite applied to only one target would ship a silent
 * behavioural split between the two platforms.
 *
 * ## Why this is a diff BASELINE, not a byte-equality assertion
 *
 * The naive assertion — "after stripping frontmatter and `sentinal:` prefixes
 * the two files are byte-equal" — is FALSE for 4 of the 7 pairs, and would
 * fail on the very first run against an unmodified tree. The divergences are
 * genuine platform capability differences, most notably `spec-implement`:
 * Claude Code can spawn `Agent(isolation="worktree")` while OpenCode has no
 * worktree-isolated agent type and must use `Task(subagent_type="general")`
 * plus an OpenCode-only safety paragraph about the shared working directory.
 *
 * So instead: normalise both sides, compute a unified diff, and assert it
 * equals a committed baseline in `__fixtures__/target-parity/<pair>.diff`.
 *
 *   - A one-sided edit changes the diff  -> this test fails with a readable delta.
 *   - An intentional new divergence requires an explicit baseline update,
 *     which is reviewable in the PR.
 *   - Three baselines are EMPTY (`spec-verify`, `spec-bugfix-verify`,
 *     `spec-master-plan`). An empty baseline is the strongest possible
 *     assertion — those pairs are byte-equal after normalisation and must
 *     stay that way. Do not let an empty baseline acquire content casually.
 *
 * To regenerate a baseline after an intentional divergence:
 *   UPDATE_PARITY_BASELINES=1 bun test src/cli/target-parity.test.ts
 * ...then read the resulting `.diff` and justify every hunk in review.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_DIR = join(__dirname, "__fixtures__", "target-parity");

/** Set to regenerate baselines. Never leave this on in CI. */
const UPDATE = process.env.UPDATE_PARITY_BASELINES === "1";

/**
 * The pairs that must stay in sync across targets.
 *
 * Two shapes live here, because OpenCode puts them in two different places:
 *
 *   - `spec-*` are Claude Code **commands** and OpenCode **skills**
 *     (`skills/<n>/SKILL.md`) — they are invoked programmatically by the
 *     `/spec` dispatcher, not typed by the user.
 *   - `spec`, `sync`, `learn`, `pause` and `quick` are **commands on both
 *     sides** (`commands/<n>.md`), because the user types them.
 *
 * Every command-dir pair that exists on both sides is now listed. The four
 * added after the initial scoped pass — `spec`, `learn`, `pause`, `quick` —
 * had their baselines seeded and reviewed hunk-by-hunk; see
 * {@link OPENCODE_COMMAND_PAIRS} for what each recorded divergence is.
 */
const PAIRS: string[] = [
  "spec-plan",
  "spec-implement",
  "spec-verify",
  "spec-bugfix-plan",
  "spec-bugfix-verify",
  "spec-master-plan",
  "spec-master-execute",
  "sync",
  "spec",
  "learn",
  "pause",
  "quick",
];

/**
 * Pairs whose OpenCode copy lives in `commands/`, not `skills/<n>/`.
 *
 * `sync.diff` is NOT empty, and its single hunk is expected: Claude Code writes
 * `Skill(skill="sentinal:learn")` while OpenCode writes `Skill(skill="learn")`.
 * `stripSentinalPrefix` below only strips the SINGLE-quoted form
 * (`Skill(skill='sentinal:`), so this double-quoted one survives normalisation
 * and shows up in the baseline. That is a real, reviewed divergence — do not
 * "fix" it by widening the normaliser without checking what else that would
 * silently start ignoring.
 *
 * The other four, and what their seeded baselines record:
 *
 *   - `learn`, `pause` and `quick` came out **byte-equal** after
 *     normalisation, so all three are in {@link MUST_STAY_BYTE_EQUAL}. Their
 *     only real divergence is frontmatter — Claude Code carries
 *     `user-invocable`/`model` keys OpenCode has no concept of — and
 *     frontmatter is stripped. The bodies are already identical prose.
 *   - `spec.diff` is the one large baseline, and it is NOT a capability
 *     difference: OpenCode's dispatcher is a genuinely condensed rewrite of
 *     the same routing logic (`Skill(skill='spec-plan', args=…)` vs
 *     "Load skill `spec-plan` with …", and the Claude Code allowed-tools
 *     paragraph has no OpenCode counterpart). Freezing it is the point — the
 *     two dispatchers must not drift FURTHER apart unnoticed. Converging them
 *     is a separate, reviewable change that should shrink this baseline.
 */
const OPENCODE_COMMAND_PAIRS = new Set<string>([
  "sync",
  "spec",
  "learn",
  "pause",
  "quick",
]);

/**
 * Baselines that are currently empty and are expected to STAY empty.
 * Listed explicitly so that a future edit which silently introduces a
 * divergence into a byte-equal pair cannot be waved through by a
 * baseline regeneration alone.
 */
const MUST_STAY_BYTE_EQUAL = new Set<string>([
  "spec-verify",
  "spec-bugfix-verify",
  "spec-master-plan",
  // Seeded with the command-dir pairs below; measured 0-byte, not assumed.
  "learn",
  "pause",
  "quick",
]);

/**
 * Rules files shipped byte-identically to both targets.
 *
 * ⛔ If you edit `targets/claude-code/rules/<x>.md` AND
 * `targets/opencode/rules/<x>.md` in the same change, ADD `<x>.md` here.
 * An allowlist only guards what it remembers, and an unguarded pair can drift
 * silently — which is the exact failure this suite exists to prevent.
 *
 * Deliberately NOT a `readdirSync` over `targets/claude-code/rules/`: the two
 * directories do not hold the same set of files (OpenCode ships extras, and
 * `sentinal-opencode-rules.md` documents that OpenCode has no `paths:`
 * frontmatter, so some rules legitimately differ). Widening to "every file
 * with a counterpart" would assert a premise nobody has verified. Explicit
 * membership keeps each entry a measured claim.
 */
const IDENTICAL_RULES: string[] = [
  "verification.md",
  "playwright-cli.md",
  // Added by the Phase 1 consistency sweep (Task 7), which edited both copies
  // identically ("use a browser-automation tool with instance isolation").
  // Verified byte-identical at the time of adding.
  "testing.md",
  // Added when the graph-reach capability contract was appended to both copies
  // identically. It was already byte-identical before that edit but UNGUARDED,
  // so it could have drifted silently; guarding it now closes that gap.
  "mcp-servers.md",
];

function ccPath(pair: string): string {
  return join(REPO_ROOT, "targets", "claude-code", "commands", `${pair}.md`);
}

function ocPath(pair: string): string {
  return OPENCODE_COMMAND_PAIRS.has(pair)
    ? join(REPO_ROOT, "targets", "opencode", "commands", `${pair}.md`)
    : join(REPO_ROOT, "targets", "opencode", "skills", pair, "SKILL.md");
}

/**
 * Strip a leading YAML frontmatter block. Frontmatter is a permitted
 * divergence: Claude Code uses `description`/`argument-hint`/`model`,
 * OpenCode uses `name`/`description`.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return text;
  return text.slice(end + "\n---\n".length);
}

/**
 * Strip the `sentinal:` namespace prefix, which Claude Code requires on
 * plugin-provided skills/agents and OpenCode forbids
 * (`src/cli/target-assets.test.ts` asserts both directions).
 *
 * Both literal forms present in the CC files are handled:
 *   subagent_type="sentinal:spec-reviewer"
 *   Skill(skill='sentinal:spec-implement', ...)
 */
function stripSentinalPrefix(text: string): string {
  return text
    .replaceAll('subagent_type="sentinal:', 'subagent_type="')
    .replaceAll("Skill(skill='sentinal:", "Skill(skill='");
}

function normalise(text: string): string[] {
  return stripSentinalPrefix(stripFrontmatter(text)).split("\n");
}

/** Longest-common-subsequence table. Files are ~500 lines, so O(n*m) is fine. */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + (j + 1)]!);
    }
  }
  return table;
}

type Op = { kind: " " | "-" | "+"; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const w = b.length + 1;
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + (j + 1)]!) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

const CONTEXT = 3;

/**
 * Render a unified diff with `@@` hunk headers. Deliberately hand-rolled
 * rather than shelled out to `diff(1)`, whose output differs between BSD
 * and GNU implementations — a baseline generated on macOS would then fail
 * in Linux CI.
 */
function unifiedDiff(a: string[], b: string[]): string {
  const ops = diffOps(a, b);
  if (!ops.some((o) => o.kind !== " ")) return "";

  // Indices of changed ops, expanded by CONTEXT and merged into hunks.
  const changed: number[] = [];
  ops.forEach((o, idx) => {
    if (o.kind !== " ") changed.push(idx);
  });

  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  // Running 1-based line numbers into a and b.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 1;
  let bi = 1;
  for (const o of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (o.kind !== "+") ai++;
    if (o.kind !== "-") bi++;
  }

  const out: string[] = [];
  for (const [start, end] of hunks) {
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k]!.kind !== "+") aCount++;
      if (ops[k]!.kind !== "-") bCount++;
    }
    out.push(
      `@@ -${aAt[start]},${aCount} +${bAt[start]},${bCount} @@`.replace(
        /\s+$/,
        "",
      ),
    );
    for (let k = start; k <= end; k++) {
      out.push(`${ops[k]!.kind}${ops[k]!.line}`);
    }
  }
  return out.join("\n") + "\n";
}

function baselinePath(pair: string): string {
  return join(BASELINE_DIR, `${pair}.diff`);
}

/**
 * Read a committed baseline, treating a MISSING file as a hard failure.
 *
 * ⛔ Returning `""` for a missing file would make `rm <pair>.diff` a no-op for
 * this suite: the parity assertion would compare against `""` and the
 * must-stay-empty assertion would also see `""`. Both would pass vacuously and
 * the recorded divergence would be silently gone. A 0-byte baseline is a
 * deliberate, reviewable artefact — its ABSENCE is not the same claim, so the
 * two cases must be distinguishable.
 */
function readBaseline(pair: string): string {
  const p = baselinePath(pair);
  if (!existsSync(p)) {
    throw new Error(
      `Missing parity baseline for "${pair}": ${p}\n\n` +
        `A baseline file must exist for every pair, even when it is EMPTY — an\n` +
        `empty baseline asserts "these two files are byte-equal after\n` +
        `normalisation", which is the strongest claim this suite can make.\n` +
        `A deleted baseline asserts nothing at all.\n\n` +
        `If the deletion was intentional, remove "${pair}" from PAIRS.\n` +
        `Otherwise restore it (git checkout) or regenerate with\n` +
        `UPDATE_PARITY_BASELINES=1 and justify the result in review.`,
    );
  }
  return readFileSync(p, "utf-8");
}

describe("Cross-target content parity", () => {
  describe.each(PAIRS)("%s", (pair) => {
    it("has both a Claude Code command and an OpenCode skill", () => {
      expect(existsSync(ccPath(pair))).toBe(true);
      expect(existsSync(ocPath(pair))).toBe(true);
    });

    it("has a committed baseline file on disk", () => {
      // Explicit and separate from the content comparison so a DELETED
      // baseline reports as "the artefact is gone", not as "the diff changed".
      // Skipped under UPDATE, which creates the file as part of its job.
      if (UPDATE) return;
      expect(existsSync(baselinePath(pair))).toBe(true);
    });

    it("differs from its counterpart exactly as recorded in the committed baseline", () => {
      const cc = normalise(readFileSync(ccPath(pair), "utf-8"));
      const oc = normalise(readFileSync(ocPath(pair), "utf-8"));
      const actual = unifiedDiff(cc, oc);

      if (UPDATE) {
        mkdirSync(BASELINE_DIR, { recursive: true });
        writeFileSync(baselinePath(pair), actual, "utf-8");
      }

      const expected = readBaseline(pair);
      if (actual !== expected) {
        // A bare "not equal" is useless for a 500-line file; show the delta
        // between the recorded divergence and the observed one.
        const delta = unifiedDiff(expected.split("\n"), actual.split("\n"));
        throw new Error(
          `Cross-target parity for "${pair}" changed.\n\n` +
            `An edit was almost certainly applied to only ONE target. Apply it to\n` +
            `both, or — if the divergence is a genuine platform capability difference —\n` +
            `regenerate with UPDATE_PARITY_BASELINES=1 and justify it in review.\n\n` +
            `  CC: ${ccPath(pair)}\n` +
            `  OC: ${ocPath(pair)}\n` +
            `  baseline: ${baselinePath(pair)}\n\n` +
            `Change to the recorded divergence (- baseline, + observed):\n${delta}`,
        );
      }
      expect(actual).toBe(expected);
    });

    if (MUST_STAY_BYTE_EQUAL.has(pair)) {
      it("is byte-equal after normalisation (empty baseline must stay empty)", () => {
        // readBaseline THROWS on a missing file, so this cannot be satisfied
        // by deleting the baseline — only by a genuinely 0-byte one.
        expect(readBaseline(pair)).toBe("");
      });
    }
  });
});

describe("Cross-target rules byte-identity", () => {
  it.each(IDENTICAL_RULES)(
    "%s is byte-identical across both targets",
    (name) => {
      const cc = readFileSync(
        join(REPO_ROOT, "targets", "claude-code", "rules", name),
        "utf-8",
      );
      const oc = readFileSync(
        join(REPO_ROOT, "targets", "opencode", "rules", name),
        "utf-8",
      );
      if (cc !== oc) {
        throw new Error(
          `targets/*/rules/${name} diverged across targets. These files carry no\n` +
            `frontmatter and no sentinal: prefixes, so they must be byte-identical.\n\n` +
            unifiedDiff(cc.split("\n"), oc.split("\n")),
        );
      }
      expect(oc).toBe(cc);
    },
  );
});
