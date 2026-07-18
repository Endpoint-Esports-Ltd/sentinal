#!/usr/bin/env bun
/**
 * Embedded-assets freshness + determinism guard (CI).
 *
 * `src/cli/embedded-assets.ts` is generated and NOT committed. This guard proves
 * two properties on every CI run so the generated-not-committed model stays safe:
 *
 *   1. DETERMINISM — running the generator twice yields byte-identical output.
 *      (A regression here, e.g. re-introducing a timestamp, would make the file
 *      churn and defeat any reproducibility guarantee.)
 *   2. CONTENT FRESHNESS — the freshly generated output actually contains the
 *      current targets/ content. We spot-check the two OpenCode master skills
 *      (the exact assets whose staleness caused the original bug) by asserting
 *      their `name:` frontmatter is present in the generated EMBEDDED_OC_SKILLS.
 *
 * Exit 0 = pass, exit 1 = fail (fails the CI job).
 *
 * Usage: bun scripts/check-embed-assets.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GENERATOR = "scripts/embed-assets.mjs";
const OUTPUT = "src/cli/embedded-assets.ts";

function generate() {
  execFileSync("bun", [GENERATOR], { stdio: "ignore" });
  return readFileSync(OUTPUT, "utf-8");
}

function fail(msg) {
  console.error(`✗ embed-assets guard: ${msg}`);
  process.exit(1);
}

// 1. Determinism — two runs must be byte-identical.
const first = generate();
const second = generate();
if (first !== second) {
  fail(
    "generator is NON-DETERMINISTIC — two runs differ. Remove any timestamp / " +
      "non-reproducible content from scripts/embed-assets.mjs.",
  );
}

// 2. Content freshness — master skills (the original-bug assets) must be present
//    with their name: frontmatter in the generated output.
for (const name of ["spec-master-plan", "spec-master-execute"]) {
  if (!second.includes(`name: ${name}`)) {
    fail(
      `generated ${OUTPUT} is missing 'name: ${name}' — the generator did not ` +
        `pick up targets/opencode/skills/${name}/. Check targets/ and re-run.`,
    );
  }
}

console.log("✓ embed-assets guard: deterministic + master skills present");
