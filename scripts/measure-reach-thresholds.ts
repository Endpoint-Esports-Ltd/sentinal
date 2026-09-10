#!/usr/bin/env bun
/**
 * Reach-threshold calibration measurement.
 *
 * Prints the evidence needed to decide whether `src/analysis/reach.ts`'s
 * cutoffs (`HIGH_REACH_MIN`/`HIGH_REACH_SHARE`, `MEDIUM_REACH_MIN`/
 * `MEDIUM_REACH_SHARE`) are still justified by this repo's actual shape.
 *
 * ⛔ **A script, not a `*.test.ts`.** As a test it would join the default `bun
 * test` suite, measure the *live* repository, and drift with every commit —
 * eventually either asserting nothing useful or failing for reasons unrelated
 * to the change under test. The durable artifact is the verdict block appended
 * to `docs/plans/2026-08-24-code-graph-impact-planning.md`, not a green tick.
 *
 * Sections: (1) transitive-importer distribution, split by population, because
 * `ec642c6`'s quoted percentiles were over **non-test source modules** while
 * its denominator was the **whole** module set — reporting one without the
 * other makes those numbers irreproducible; (2) classification rates and which
 * condition in each tier binds; (3) a sensitivity grid; (4) the HIGH-rate
 * change from Task 1 restoring `hasUnexpected`, over real changesets recovered
 * from git; (5) single-hop reach as a cheap second granularity model.
 *
 * Usage: `bun scripts/measure-reach-thresholds.ts [projectRoot]`
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImportGraph,
  transitiveImporters,
  type ImportGraph,
} from "../src/analysis/imports.js";
import {
  extractSpecFiles,
  isExpectedFile,
  type ChangedFile,
} from "../src/analysis/helpers.js";
import { scoreRisk } from "../src/analysis/impact.js";
import {
  HIGH_REACH_MIN,
  HIGH_REACH_SHARE,
  MEDIUM_REACH_MIN,
  MEDIUM_REACH_SHARE,
  isHighReach,
  isMediumReach,
  isReachRelevantPath,
} from "../src/analysis/reach.js";

const PROJECT = process.argv[2] ?? process.cwd();

// --- Small utilities ---

/** Nearest-rank percentile over an ascending array. */
function pct(sorted: number[], p: number): number {
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))] ?? 0;
}

const mean = (v: number[]): number =>
  v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;

const share = (n: number, total: number): string =>
  total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;

/** Fixed-width markdown-ish table. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    "| " + cells.map((c, i) => (c ?? "").padEnd(widths[i])).join(" | ") + " |";
  return [
    line(headers),
    "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|",
    ...rows.map(line),
  ].join("\n");
}

/** `label | n | p50 | p75 | p90 | p95 | max` — shared by sections 1 and 5. */
function statsRow(label: string, v: number[]): string[] {
  return [
    label,
    String(v.length),
    ...[50, 75, 90, 95].map((p) => String(pct(v, p))),
    String(v[v.length - 1] ?? 0),
  ];
}
const STATS_HEAD = ["", "n", "p50", "p75", "p90", "p95", "max"];

function heading(text: string): void {
  console.log(`\n${text}\n${"=".repeat(text.length)}`);
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: PROJECT });
  return new TextDecoder().decode(proc.stdout);
}

// --- 1: reach distribution ---

const graph: ImportGraph = buildImportGraph(PROJECT);
const MODULE_COUNT = graph.modules.size;

const isTestModule = (id: string): boolean => /\.(test|spec)$/.test(id);

const reachById = new Map<string, number>();
for (const id of graph.modules) {
  reachById.set(id, transitiveImporters(graph, id).size);
}

const populations = [
  { name: "all modules", ids: [...graph.modules] },
  {
    name: "non-test source",
    ids: [...graph.modules].filter((m) => !isTestModule(m)),
  },
  { name: "test modules", ids: [...graph.modules].filter(isTestModule) },
].map((p) => ({
  name: p.name,
  values: p.ids.map((m) => reachById.get(m)!).sort((a, b) => a - b),
}));

heading("1. Reach distribution — transitive importers (built-in module model)");
console.log(
  `Universe (graph.modules.size, the divisor used for every share): ${MODULE_COUNT}\n\n` +
    table(
      ["population", ...STATS_HEAD.slice(1), "mean"],
      populations.map((p) => [
        ...statsRow(p.name, p.values),
        mean(p.values).toFixed(1),
      ]),
    ) +
    "\n\nBaseline `ec642c6` (2026-08-23): 334 modules, p50 = 10, p75 = 82." +
    "\nThose percentiles reproduce against the NON-TEST SOURCE row, not the" +
    "\n`all modules` row — the quoted 334 was the divisor, not the population.",
);

// --- 2: classification rates ---

heading("2. Classification rates under the current cutoffs");
const cut = (s: number): string => (MODULE_COUNT * s).toFixed(1);
console.log(
  `HIGH   = reach >= ${HIGH_REACH_MIN} AND reach >= ${HIGH_REACH_SHARE} * ${MODULE_COUNT} (= ${cut(HIGH_REACH_SHARE)})` +
    `\nMEDIUM = reach >= ${MEDIUM_REACH_MIN} AND reach >= ${MEDIUM_REACH_SHARE} * ${MODULE_COUNT} (= ${cut(MEDIUM_REACH_SHARE)})\n`,
);

interface Bands {
  high: number;
  med: number;
  low: number;
}
function classify(v: number[]): Bands {
  const high = v.filter((x) => isHighReach(x, MODULE_COUNT)).length;
  const med = v.filter(
    (x) => !isHighReach(x, MODULE_COUNT) && isMediumReach(x, MODULE_COUNT),
  ).length;
  return { high, med, low: v.length - high - med };
}

console.log(
  table(
    ["population", "n", "LOW", "MEDIUM", "HIGH"],
    populations.map(({ name, values: v }) => {
      const c = classify(v);
      return [
        name,
        String(v.length),
        ...([c.low, c.med, c.high] as const).map(
          (n) => `${n} (${share(n, v.length)})`,
        ),
      ];
    }),
  ),
);

const all = populations[0].values;
const absOnlyHigh = all.filter((v) => v >= HIGH_REACH_MIN).length;
const absOnlyMed = all.filter((v) => v >= MEDIUM_REACH_MIN).length;
console.log(
  `\nWhich condition binds (all modules, n = ${all.length}):` +
    `\n  reach >= ${HIGH_REACH_MIN} alone would mark HIGH:      ${absOnlyHigh} (${share(absOnlyHigh, all.length)})` +
    `\n  both conditions (current) mark HIGH:      ${classify(all).high} (${share(classify(all).high, all.length)})` +
    `\n  reach >= ${MEDIUM_REACH_MIN} alone would mark >= MEDIUM: ${absOnlyMed} (${share(absOnlyMed, all.length)})`,
);

// --- 3: sensitivity ---

heading("3. Sensitivity — HIGH rate (all modules) across candidate cutoffs");
const shares = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
const rate = (f: number, s: number): string =>
  share(all.filter((v) => v >= f && v >= MODULE_COUNT * s).length, all.length);
console.log(
  table(
    ["floor \\ share", ...shares.map((s) => `${(s * 100).toFixed(0)}%`)],
    [4, 8, 16, 32, 64].map((f) => [
      String(f),
      ...shares.map((s) => rate(f, s)),
    ]),
  ),
);

// --- 4: Task 1 HIGH-rate delta ---

heading("4. Task 1 delta — HIGH rate with `hasUnexpected` dead vs restored");
console.log(
  "Corpus: every commit touching exactly one `docs/plans/*.md` — where an agent" +
    "\nfinished a task. Real changesets, paired with the plan as read at that SHA." +
    "\n  before = scoreRisk(files, new Set(), moduleCount)  // specFiles always empty" +
    "\n  after  = scoreRisk(files, extractSpecFiles(plan), moduleCount)" +
    "\nReach uses TODAY's graph — that biases both arms identically, so it cannot" +
    "\ndistort the delta, which is driven purely by `hasUnexpected`.",
);

const tmp = join(mkdtempSync(join(tmpdir(), "reach-thresholds-")), "plan.md");

/**
 * Commits touching a plan, with their FULL file lists.
 *
 * ⛔ Two calls, deliberately. `git log --name-only -- docs/plans/` filters the
 * printed file list down to the pathspec, so a single call yields only the
 * plan and its review artifacts — which are never in a `Files:` block and so
 * are unexpected by construction. Measured that way the corpus reports a
 * flawless 100% newly-HIGH that is pure artifact. Select the SHAs with the
 * pathspec; read each changeset back WITHOUT it.
 */
function commitFileLists(): Array<{ sha: string; files: string[] }> {
  return git(["log", "--format=%H", "--", "docs/plans/"])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((sha) => ({
      sha,
      files: git(["show", "--name-only", "--format=", "--no-renames", sha])
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    }))
    .filter((c) => c.files.length > 0);
}

const SRC_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function reachOf(relPath: string): number {
  if (!isReachRelevantPath(relPath)) return 0;
  return reachById.get(join(PROJECT, relPath).replace(SRC_EXT, "")) ?? 0;
}

/** Only the two fields `scoreRisk` reads carry real values; length is inert. */
const toChangedFiles = (
  relPaths: string[],
  specFiles: Set<string>,
): ChangedFile[] =>
  relPaths.map((relPath) => ({
    path: join(PROJECT, relPath),
    relPath,
    isExpected: isExpectedFile(relPath, specFiles),
    lineCount: 0,
    overLimit: false,
    importerCount: reachOf(relPath),
  }));

/** Code the plan could plausibly have listed — excludes lockfiles, docs, CI. */
const isSourcePath = (f: string): boolean =>
  /^(src|targets|scripts|tests|bin|templates)\//.test(f);

/**
 * Generated output. No plan lists it because no human edits it, so counting it
 * as an unexpected change measures the build, not the agent's discipline.
 */
const GENERATED = new Set(["src/cli/embedded-assets.ts"]);

interface Tally {
  n: number;
  highBefore: number;
  highAfter: number;
  flipped: number;
}
/** Four changeset definitions, so the delta cannot be an artifact of one. */
type Arm = { label: string; pick: (f: string[], plan: string) => string[] };
const arms: Arm[] = [
  { label: "work files only", pick: (f, p) => f.filter((x) => x !== p) },
  { label: "+ the plan file", pick: (f) => f },
  { label: "source files only", pick: (f) => f.filter(isSourcePath) },
  {
    label: "source, minus generated",
    pick: (f) => f.filter((x) => isSourcePath(x) && !GENERATED.has(x)),
  },
];
const tallies: Tally[] = arms.map(() => ({
  n: 0,
  highBefore: 0,
  highAfter: 0,
  flipped: 0,
}));
const unexpectedFreq = new Map<string, number>();
let emptySpec = 0;
let checkboxOnly = 0;
let multiPlan = 0;

for (const commit of commitFileLists()) {
  const planPaths = commit.files.filter(
    (f) => f.startsWith("docs/plans/") && f.endsWith(".md"),
  );
  if (planPaths.length !== 1) {
    multiPlan++;
    continue; // which plan was active is genuinely ambiguous — do not guess
  }
  const planPath = planPaths[0];
  const content = git(["show", `${commit.sha}:${planPath}`]);
  if (content.length === 0) continue;
  writeFileSync(tmp, content);
  const specFiles = extractSpecFiles(tmp);
  if (specFiles.size === 0) {
    emptySpec++;
    continue; // no Files: blocks — `hasUnexpected` cannot fire in either arm
  }
  if (commit.files.length === 1) {
    checkboxOnly++;
    continue;
  }

  arms.forEach((arm, i) => {
    const paths = arm.pick(commit.files, planPath);
    if (paths.length === 0) return;
    const tally = tallies[i];
    tally.n++;
    const scored = toChangedFiles(paths, specFiles);
    const none = new Set<string>();
    const before = scoreRisk(toChangedFiles(paths, none), none, MODULE_COUNT);
    const after = scoreRisk(scored, specFiles, MODULE_COUNT);
    if (before === "HIGH") tally.highBefore++;
    if (after === "HIGH") tally.highAfter++;
    if (before !== "HIGH" && after === "HIGH") tally.flipped++;
    // Diagnose from the strictest arm only, so each path is counted once.
    if (i !== arms.length - 1) return;
    for (const f of scored.filter((x) => !x.isExpected)) {
      unexpectedFreq.set(f.relPath, (unexpectedFreq.get(f.relPath) ?? 0) + 1);
    }
  });
}

console.log(
  "\n" +
    table(
      ["changeset", "scenarios", "HIGH before", "HIGH after", "newly HIGH"],
      arms.map(({ label }, i) => {
        const t = tallies[i];
        return [
          label,
          String(t.n),
          `${t.highBefore} (${share(t.highBefore, t.n)})`,
          `${t.highAfter} (${share(t.highAfter, t.n)})`,
          `${t.flipped} (${share(t.flipped, t.n)})`,
        ];
      }),
    ) +
    `\n\nSkipped: ${emptySpec} plans with no parseable \`Files:\` block, ` +
    `${checkboxOnly} checkbox-only commits, ${multiPlan} commits touching several plans.`,
);

heading(`4b. What is flagged (strictest arm: ${arms[arms.length - 1].label})`);
console.log(
  table(
    ["unexpected path", "scenarios"],
    [...unexpectedFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([p, n]) => [p, String(n)]),
  ) +
    `\n\n${unexpectedFreq.size} distinct source paths flagged across the corpus.` +
    "\nA long tail of real implementation files => the restored signal is true and" +
    "\nthe rate is a property of how plans are written, not of the measurement.",
);

// --- 5: second granularity model ---

heading("5. Informative — single-hop reach (a second granularity model)");
console.log(
  "D1 means exactly one source is ever scored, so cross-model calibration is no" +
    "\nlonger load-bearing. A symbol-level universe was NOT measured: it needs an" +
    "\nexternal code-graph server, none is catalogued here, and nothing would score" +
    "\nfrom it. Single-hop reach is free from the same graph, so it stands in.\n",
);
const direct = [...graph.modules]
  .map((m) => graph.importers.get(m)?.size ?? 0)
  .sort((a, b) => a - b);
const modelRow = (label: string, v: number[]): string[] => [
  ...statsRow(label, v),
  `${classify(v).high} (${share(classify(v).high, v.length)})`,
];
console.log(
  table(
    ["model", ...STATS_HEAD.slice(1), `HIGH under ${HIGH_REACH_SHARE * 100}%`],
    [modelRow("transitive", all), modelRow("single-hop", direct)],
  ) +
    "\n\nSame files, same universe, different model — and the HIGH band collapses." +
    "\nThat is D1's argument reproduced with numbers from this repo: a share" +
    "\ncutoff means nothing outside the model it was derived from.",
);
