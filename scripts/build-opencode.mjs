#!/usr/bin/env node

/**
 * OpenCode Plugin Build Script
 *
 * Bundles targets/opencode/plugins/sentinal.ts into a single self-contained
 * ESM file with the given version baked in via `--define __SENTINAL_VERSION__`.
 *
 * The version is a REQUIRED argument, never read from package.json here:
 * semantic-release runs release-build.mjs (the @semantic-release/exec prepare
 * step) BEFORE @semantic-release/npm bumps package.json, so reading it would
 * bake the PREVIOUS release's version (1.38.0 shipped a plugin reporting
 * "1.37.1"). Local builds pass package.json's version explicitly
 * (`bun run build:opencode`).
 *
 * Usage: node scripts/build-opencode.mjs <version> [outfile]
 *
 * Also exports the helpers release-build.mjs / pre-release.mjs use to verify
 * the version actually landed in every shipped copy of the plugin.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ENTRY = "targets/opencode/plugins/sentinal.ts";
export const DEFAULT_OUTFILE = "targets/opencode/dist/sentinal.mjs";
export const EMBEDDED_ASSETS = "src/cli/embedded-assets.ts";

// Native / runtime-provided modules only. Everything else (zod included) MUST
// be bundled — see the self-contained guard in src/cli/target-assets.test.ts.
const EXTERNALS = ["bun:sqlite", "@xenova/transformers", "sqlite-vec"];

/** Build the plugin bundle for `version` into `outfile` (repo-relative or absolute). */
export function buildOpencode(version, outfile = DEFAULT_OUTFILE) {
  if (!version) throw new Error("buildOpencode: version is required");
  const args = [
    "build",
    ENTRY,
    "--outfile",
    resolve(REPO_ROOT, outfile),
    "--target",
    "node",
    "--format",
    "esm",
    ...EXTERNALS.flatMap((e) => ["--external", e]),
    "--define",
    `__SENTINAL_VERSION__=${JSON.stringify(version)}`,
  ];
  execFileSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
}

// `bun build` with the define applied emits
//   function getSentinalVersion() {\n  if (true) {\n    return "X";
// Without it the body starts with `if (typeof __SENTINAL_VERSION__ ...`, which
// does not match. The embedded copy (a template literal) keeps the same text.
const BAKED_RE =
  /function getSentinalVersion\d*\(\)\s*\{\s*(?:if\s*\(\s*(?:true|!0)\s*\)\s*\{?\s*)?return\s*"([^"]*)"/g;

function allBakedVersions(text) {
  return [...text.matchAll(BAKED_RE)].map((m) => m[1]);
}

/** The version baked into a bundle (or its embedded copy), or null if none. */
export function readBakedVersion(text) {
  return allBakedVersions(text)[0] ?? null;
}

/**
 * Check every path carries `version` as its baked getSentinalVersion.
 * Returns human-readable problems; an empty array means all good.
 */
export function verifyBakedVersion(version, paths) {
  const problems = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      problems.push(`${p}: file not found`);
      continue;
    }
    const found = allBakedVersions(readFileSync(p, "utf-8"));
    if (found.length === 0) {
      problems.push(`${p}: no baked getSentinalVersion (define missing?)`);
    } else if (found.some((v) => v !== version)) {
      problems.push(
        `${p}: bakes ${found.map((v) => `"${v}"`).join(", ")}, expected "${version}"`,
      );
    }
  }
  return problems;
}

/** The files that ship the plugin: the npm/dist bundle and the binaries' embedded copy. */
export function shippedPluginPaths() {
  return [join(REPO_ROOT, DEFAULT_OUTFILE), join(REPO_ROOT, EMBEDDED_ASSETS)];
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  const [version, outfile] = process.argv.slice(2);
  if (!version) {
    console.error("Usage: node scripts/build-opencode.mjs <version> [outfile]");
    process.exit(1);
  }
  buildOpencode(version, outfile);
}
