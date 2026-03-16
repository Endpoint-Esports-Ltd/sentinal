#!/usr/bin/env node

/**
 * Release Build Script
 *
 * Called by semantic-release's @semantic-release/exec plugin during the prepare phase.
 * Cross-compiles sentinal for 4 platform targets with the release version injected.
 *
 * Usage: node scripts/release-build.mjs <version>
 * Example: node scripts/release-build.mjs 1.3.0
 */

import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/release-build.mjs <version>");
  process.exit(1);
}

const TARGETS = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
];

const DIST_DIR = "dist";
const ENTRY = "src/cli/index.ts";

// Ensure dist directory exists
if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

// Bundle OpenCode plugin and generate embedded assets before compiling
console.log("Bundling OpenCode plugin and embedding assets...");
execSync("bun run build:opencode", { stdio: "inherit" });
execSync("node scripts/embed-assets.mjs", { stdio: "inherit" });

console.log(`Building sentinal v${version} for ${TARGETS.length} platforms...`);

for (const { os, arch } of TARGETS) {
  const target = `bun-${os}-${arch}`;
  const outfile = `${DIST_DIR}/sentinal-${os}-${arch}`;
  const define = `--define __SENTINAL_VERSION__="'${version}'"`;

  console.log(`  Compiling ${target}...`);
  execSync(
    `bun build --compile --target=${target} ${ENTRY} --outfile ${outfile} ${define}`,
    { stdio: "inherit" },
  );
}

// Generate checksums
console.log("Generating checksums...");
const checksumFiles = TARGETS.map(
  ({ os, arch }) => `sentinal-${os}-${arch}`,
).join(" ");
execSync(`sha256sum ${checksumFiles} > checksums.txt`, {
  cwd: DIST_DIR,
  stdio: "inherit",
});

console.log(`Build complete. Artifacts in ${DIST_DIR}/:`);
execSync(`ls -lh ${DIST_DIR}/sentinal-* ${DIST_DIR}/checksums.txt`, {
  stdio: "inherit",
});
