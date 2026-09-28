/**
 * Release bake of the Claude Code plugin manifest's version (D6 of
 * docs/plans/2026-09-28-deferred-items.md).
 *
 * `scripts/release-build.mjs` / `pre-release.mjs` write the release version
 * into `targets/claude-code/.claude-plugin/plugin.json` BEFORE embed-assets
 * copies it into `EMBEDDED_CC_PLUGIN_JSON`, then verify both. These tests run
 * the helpers against temp copies only — never the real repo files.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cc-plugin-version.mjs");

type Helpers = {
  CC_PLUGIN_JSON: string;
  shippedManifestPaths: () => { pluginJson: string; embeddedAssets: string };
  bakePluginVersion: (path: string, version: string) => void;
  readEmbeddedPluginVersion: (text: string) => string | null;
  verifyPluginVersion: (
    version: string,
    paths: { pluginJson: string; embeddedAssets: string },
  ) => string[];
};

const MANIFEST = (version: string) =>
  `{
  "name": "sentinal",
  "version": "${version}",
  "description": "Claude Code quality plugin for TypeScript, Angular, and NestJS",
  "author": {
    "name": "Sentinal"
  },
  "license": "UNLICENSED",
  "keywords": ["sentinal", "typescript", "angular", "nestjs", "quality"]
}
`;

/** The shape embed-assets.mjs emits (emitString → template literal). */
function embedded(manifest: string): string {
  const escaped = manifest
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return (
    `export const EMBEDDED_CC_LSP_JSON = \`{ "version": "9.9.9" }\`;\n` +
    `export const EMBEDDED_CC_PLUGIN_JSON = \`${escaped}\`;\n` +
    `export const EMBEDDED_CC_MCP_JSON = \`{}\`;\n`
  );
}

describe("cc-plugin-version.mjs", () => {
  let h: Helpers;
  let dir: string;

  beforeEach(async () => {
    h = (await import(SCRIPT)) as Helpers;
    dir = mkdtempSync(join(tmpdir(), "sentinal-cc-plugin-version-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, text: string): string {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  }

  it("points at the shipped Claude Code manifest", () => {
    expect(h.CC_PLUGIN_JSON).toBe(
      join(
        REPO_ROOT,
        "targets",
        "claude-code",
        ".claude-plugin",
        "plugin.json",
      ),
    );
  });

  it("shippedManifestPaths names the file and the embedded-assets copy", () => {
    expect(h.shippedManifestPaths()).toEqual({
      pluginJson: h.CC_PLUGIN_JSON,
      embeddedAssets: join(REPO_ROOT, "src", "cli", "embedded-assets.ts"),
    });
  });

  it("bakes the version and changes nothing else (formatting preserved)", () => {
    const p = write("plugin.json", MANIFEST("0.1.0"));
    h.bakePluginVersion(p, "1.40.0");
    expect(readFileSync(p, "utf-8")).toBe(MANIFEST("1.40.0"));
  });

  it("is a no-op when the version already matches", () => {
    const p = write("plugin.json", MANIFEST("1.40.0"));
    h.bakePluginVersion(p, "1.40.0");
    expect(readFileSync(p, "utf-8")).toBe(MANIFEST("1.40.0"));
  });

  it("only rewrites the top-level version, not a nested one", () => {
    const text =
      `{\n  "name": "sentinal",\n  "version": "0.1.0",\n` +
      `  "author": { "name": "x", "version": "keep" }\n}\n`;
    const p = write("plugin.json", text);
    h.bakePluginVersion(p, "2.0.0");
    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.version).toBe("2.0.0");
    expect(out.author.version).toBe("keep");
  });

  it("refuses a manifest without a version field", () => {
    const p = write("plugin.json", `{\n  "name": "sentinal"\n}\n`);
    expect(() => h.bakePluginVersion(p, "1.40.0")).toThrow(/version/);
  });

  it("refuses an empty version", () => {
    const p = write("plugin.json", MANIFEST("0.1.0"));
    expect(() => h.bakePluginVersion(p, "")).toThrow(/version/);
  });

  it("reads the version from the embedded copy, not a sibling constant", () => {
    expect(h.readEmbeddedPluginVersion(embedded(MANIFEST("1.40.0")))).toBe(
      "1.40.0",
    );
    expect(h.readEmbeddedPluginVersion("nothing here")).toBeNull();
  });

  it("verify passes when the file and the embedded copy carry the version", () => {
    const pluginJson = write("plugin.json", MANIFEST("1.40.0"));
    const embeddedAssets = write("e.ts", embedded(MANIFEST("1.40.0")));
    expect(
      h.verifyPluginVersion("1.40.0", { pluginJson, embeddedAssets }),
    ).toEqual([]);
  });

  it("verify fails when the file is stale", () => {
    const pluginJson = write("plugin.json", MANIFEST("0.1.0"));
    const embeddedAssets = write("e.ts", embedded(MANIFEST("1.40.0")));
    const problems = h.verifyPluginVersion("1.40.0", {
      pluginJson,
      embeddedAssets,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(pluginJson);
    expect(problems[0]).toContain("0.1.0");
  });

  it("verify fails when only the embedded copy is stale (embed ran before the bake)", () => {
    const pluginJson = write("plugin.json", MANIFEST("1.40.0"));
    const embeddedAssets = write("e.ts", embedded(MANIFEST("0.1.0")));
    const problems = h.verifyPluginVersion("1.40.0", {
      pluginJson,
      embeddedAssets,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(embeddedAssets);
  });

  it("verify fails on missing files and a missing embedded constant", () => {
    const embeddedAssets = write("e.ts", "export const X = ``;\n");
    const problems = h.verifyPluginVersion("1.40.0", {
      pluginJson: join(dir, "nope.json"),
      embeddedAssets,
    });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("nope.json");
    expect(problems.join("\n")).toContain("EMBEDDED_CC_PLUGIN_JSON");
  });

  it("a prefix version does not pass", () => {
    const pluginJson = write("plugin.json", MANIFEST("1.40.0-beta.1"));
    const embeddedAssets = write("e.ts", embedded(MANIFEST("1.40.0-beta.1")));
    expect(
      h.verifyPluginVersion("1.40.0", { pluginJson, embeddedAssets }),
    ).toHaveLength(2);
  });
});
