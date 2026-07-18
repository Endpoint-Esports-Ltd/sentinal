#!/usr/bin/env bun
//
// Pre-release gate.
//
// Builds the CURRENT-platform release artifact (sentinal-<os>-<arch>) exactly
// as the release pipeline does (embed assets, externalize native deps, inject
// version), points the isolated E2E harness at it via SENTINAL_E2E_BINARY, and
// runs the pinned deterministic gate suite. This validates the ACTUAL release
// binary a user downloads — not just the dev build — before tagging.
//
// Default: offline, current-platform only, no token.
//   bun run pre-release
// Opt-in native-dep provisioning (network, ~150MB):
//   SENTINAL_E2E_DEPS=1 bun run pre-release
// Download + checksum-verify a published asset (needs GITHUB_TOKEN):
//   bun run pre-release -- --download   (or bun run pre-release:download)
//
// Cross-platform caveat: this host can only EXECUTE its own platform's binary
// (a Mac cannot run sentinal-linux-*). Linux `run` coverage happens by running
// this gate on a Linux CI runner. The --download mode can fetch + checksum-
// verify a linux asset from any host, but not execute it.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST = join(REPO_ROOT, "dist");
const args = process.argv.slice(2);
const DOWNLOAD = args.includes("--download");

// ── platform → artifact name ─────────────────────────────────────────────────

function currentAssetName() {
  const osMap = { darwin: "darwin", linux: "linux" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const os = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os) throw new Error(`Unsupported OS: ${process.platform} (need darwin/linux)`);
  if (!arch) throw new Error(`Unsupported arch: ${process.arch} (need x64/arm64)`);
  return `sentinal-${os}-${arch}`;
}

function pkgVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  return pkg.version ?? "0.0.0";
}

// ── build the current-platform release artifact ──────────────────────────────

function buildCurrentPlatform() {
  const version = pkgVersion();
  const assetName = currentAssetName();
  const outfile = join(DIST, assetName);
  const target = `bun-${process.platform}-${process.arch}`;
  console.log(`[pre-release] building ${assetName} (v${version}) as the release artifact...`);
  // Mirror release-build.mjs: embed assets + externalize native deps + inject version.
  execSync("bun run build:opencode", { cwd: REPO_ROOT, stdio: "inherit" });
  execSync("node scripts/embed-assets.mjs", { cwd: REPO_ROOT, stdio: "inherit" });
  execSync(
    `bun build --compile --target=${target} src/cli/index.ts --outfile ${outfile} ` +
      `--external @xenova/transformers --external sqlite-vec ` +
      `--define __SENTINAL_VERSION__="'${version}'"`,
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (!existsSync(outfile)) {
    throw new Error(`[pre-release] build did not produce ${outfile}`);
  }
  return outfile;
}

// ── the pinned gate suite (explicit paths — bun dir-scan skips *.e2e.ts) ──────

const GATE_FILES = [
  "./tests/e2e/harness/sandbox.spec-e2e.ts",
  "./tests/e2e/install.e2e.ts",
  "./tests/e2e/hooks.e2e.ts",
  "./tests/e2e/mcp.e2e.ts",
  "./tests/e2e/spec-workflow.e2e.ts",
  "./tests/e2e/sidecar-memory.e2e.ts",
  "./tests/e2e/release-identity.e2e.ts",
  "./tests/e2e/release-install.e2e.ts",
];

function runGate(binaryPath) {
  const env = { ...process.env, SENTINAL_E2E_BINARY: binaryPath };
  // Native-dep gate is opt-in; add it only when requested (network + ~150MB).
  const files = [...GATE_FILES];
  if (process.env.SENTINAL_E2E_DEPS === "1") {
    files.push("./tests/e2e/release-deps.e2e.ts");
  }
  console.log(`[pre-release] running gate against: ${binaryPath}`);
  const proc = spawnSync("bun", ["test", ...files], {
    cwd: REPO_ROOT,
    env,
    // bun test writes results (incl. the "Ran N tests" summary) to STDERR;
    // capture both streams so the 0-tests guard can inspect them.
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf-8",
  });
  // Echo captured output and guard against a mistyped path silently running 0 tests.
  const combined = (proc.stdout ?? "") + (proc.stderr ?? "");
  process.stdout.write(proc.stdout ?? "");
  process.stderr.write(proc.stderr ?? "");
  // bun prints "Ran N tests across M files"; also guard the "0 tests"/"no tests" cases.
  const ranMatch = /Ran (\d+) tests?/.exec(combined);
  const ran = ranMatch ? Number(ranMatch[1]) : 0;
  if (ran === 0) {
    throw new Error("[pre-release] gate ran 0 tests — a gate path is likely mistyped");
  }
  if (proc.status !== 0) {
    throw new Error(`[pre-release] gate FAILED (exit ${proc.status})`);
  }
  console.log(`[pre-release] gate PASSED (${ran} tests).`);
}

// ── download mode ─────────────────────────────────────────────────────────────

async function downloadArtifact() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "[pre-release] --download requires GITHUB_TOKEN (private repo).",
    );
  }
  const { downloadReleaseAsset } = await import(
    "../tests/e2e/harness/release-asset.ts"
  );
  const tag = process.env.SENTINAL_E2E_TAG; // optional; else latest
  console.log(
    `[pre-release] downloading published asset (${tag ?? "latest"}) + verifying checksum...`,
  );
  const path = await downloadReleaseAsset({
    token,
    destDir: DIST,
    ...(tag ? { tag } : {}),
  });
  console.log(`[pre-release] downloaded + verified: ${path}`);
  return path;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const binary = DOWNLOAD ? await downloadArtifact() : buildCurrentPlatform();
  runGate(binary);
  console.log("[pre-release] ✅ release gate passed for this platform.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
