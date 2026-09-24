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
import {
  buildOpencode,
  shippedPluginPaths,
  verifyBakedVersion,
} from "./build-opencode.mjs";

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

// Bundle OpenCode plugin and generate embedded assets before compiling.
// ⛔ The version is passed EXPLICITLY: this script runs in semantic-release's
// prepare step BEFORE @semantic-release/npm bumps package.json, so anything
// that reads package.json here sees the PREVIOUS release (1.38.0 shipped a
// plugin reporting "1.37.1"). Do not "fix" it by reordering .releaserc.json.
console.log("Bundling OpenCode plugin and embedding assets...");
buildOpencode(version);
execSync("bun scripts/embed-assets.mjs", { stdio: "inherit" });

// Both shipped copies must carry this release's version: the dist bundle and
// the embedded copy the compiled binaries install. Fail the release otherwise.
const versionProblems = verifyBakedVersion(version, shippedPluginPaths());
if (versionProblems.length > 0) {
  console.error(
    `OpenCode plugin does not carry release version ${version}:\n  ` +
      versionProblems.join("\n  "),
  );
  process.exit(1);
}

console.log(`Building sentinal v${version} for ${TARGETS.length} platforms...`);

for (const { os, arch } of TARGETS) {
  const target = `bun-${os}-${arch}`;
  const outfile = `${DIST_DIR}/sentinal-${os}-${arch}`;
  const define = `--define __SENTINAL_VERSION__="'${version}'"`;
  // Native deps cannot live inside compiled binaries — resolved at runtime
  // from ~/.sentinal/deps (see src/memory/native-deps.ts).
  const externals = "--external @xenova/transformers --external sqlite-vec";

  console.log(`  Compiling ${target}...`);
  execSync(
    `bun build --compile --target=${target} ${ENTRY} --outfile ${outfile} ${externals} ${define}`,
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
