/**
 * Claude Code plugin manifest version bake (D6 of
 * docs/plans/2026-09-28-deferred-items.md).
 *
 * release-build.mjs / pre-release.mjs call `bakePluginVersion` BEFORE
 * embed-assets.mjs, which copies plugin.json verbatim into
 * `EMBEDDED_CC_PLUGIN_JSON` — baking after it would ship the old version in
 * every compiled binary. `verifyPluginVersion` then checks both copies.
 *
 * The version is always passed in, never read from package.json: the release
 * build runs BEFORE @semantic-release/npm bumps it (see build-opencode.mjs).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CC_PLUGIN_JSON = join(
  REPO_ROOT,
  "targets",
  "claude-code",
  ".claude-plugin",
  "plugin.json",
);

/** The copies that ship the manifest: the file itself and the binaries' embedded copy. */
export function shippedManifestPaths() {
  return {
    pluginJson: CC_PLUGIN_JSON,
    embeddedAssets: join(REPO_ROOT, "src", "cli", "embedded-assets.ts"),
  };
}

// The top-level `"version"` sits at two-space indent in the committed file;
// anchoring on it leaves a nested `version` (none today) alone.
const TOP_LEVEL_VERSION_RE = /^( {2}"version":\s*)"[^"]*"/m;

/**
 * Write `version` into the manifest at `path`, changing only that value so the
 * file's formatting (and therefore git diff) is otherwise untouched.
 */
export function bakePluginVersion(path, version) {
  if (!version) throw new Error("bakePluginVersion: version is required");
  const text = readFileSync(path, "utf-8");
  if (!TOP_LEVEL_VERSION_RE.test(text)) {
    throw new Error(`${path}: no top-level "version" field to bake`);
  }
  const next = text.replace(
    TOP_LEVEL_VERSION_RE,
    (_, prefix) => `${prefix}${JSON.stringify(version)}`,
  );
  if (JSON.parse(next).version !== version) {
    throw new Error(`${path}: baked version did not round-trip`);
  }
  if (next !== text) writeFileSync(path, next);
}

const EMBEDDED_RE = /EMBEDDED_CC_PLUGIN_JSON\s*=\s*`((?:\\[\s\S]|[^`\\])*)`/;

/** The manifest version inside embedded-assets.ts, or null if absent/unparseable. */
export function readEmbeddedPluginVersion(text) {
  const m = EMBEDDED_RE.exec(text);
  if (!m) return null;
  // Undo embed-assets.mjs's template-literal escaping (\\ \` \${).
  const json = m[1].replace(/\\([\\`$])/g, "$1");
  try {
    const v = JSON.parse(json).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function readFileVersion(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Check the manifest and its embedded copy both carry `version`.
 * Returns human-readable problems; an empty array means all good.
 */
export function verifyPluginVersion(version, { pluginJson, embeddedAssets }) {
  const problems = [];
  const sources = [
    [pluginJson, readFileVersion],
    [
      embeddedAssets,
      (p) => readEmbeddedPluginVersion(readFileSync(p, "utf-8")),
    ],
  ];
  for (const [path, read] of sources) {
    if (!existsSync(path)) {
      problems.push(`${path}: file not found`);
      continue;
    }
    const found = read(path);
    if (found === null) {
      problems.push(
        path === embeddedAssets
          ? `${path}: no EMBEDDED_CC_PLUGIN_JSON with a version`
          : `${path}: no "version" field`,
      );
    } else if (found !== version) {
      problems.push(`${path}: carries "${found}", expected "${version}"`);
    }
  }
  return problems;
}
