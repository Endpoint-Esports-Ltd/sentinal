/**
 * Release guard for the OpenCode plugin's baked version.
 *
 * `scripts/release-build.mjs` runs on every real release and must fail it when
 * either shipped copy of the plugin — `targets/opencode/dist/sentinal.mjs`
 * (npm tarball / local deploy) or `src/cli/embedded-assets.ts` (what the
 * compiled binaries install) — does not carry the release version. These
 * tests pin the helper it uses, `verifyBakedVersion`, against fixture text in
 * the exact shapes `bun build` and `embed-assets.mjs` produce.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-opencode.mjs");

type Helpers = {
  readBakedVersion: (text: string) => string | null;
  verifyBakedVersion: (version: string, paths: string[]) => string[];
};

/** Shape emitted by `bun build` when the define is applied. */
function bakedBundle(version: string): string {
  return (
    `var cached2 = null;\n` +
    `function getSentinalVersion() {\n` +
    `  if (true) {\n` +
    `    return "${version}";\n` +
    `  }\n` +
    `  if (cached2 !== null)\n    return cached2;\n` +
    `  return "0.0.0";\n` +
    `}\n`
  );
}

/** Shape emitted by `bun build` when the define is MISSING. */
const UNDEFINED_BUNDLE =
  `function getSentinalVersion() {\n` +
  `  if (typeof __SENTINAL_VERSION__ !== "undefined") {\n` +
  `    return __SENTINAL_VERSION__;\n` +
  `  }\n` +
  `  return "0.0.0";\n` +
  `}\n`;

/** embed-assets.mjs wraps the bundle in a template literal. */
function embedded(bundle: string): string {
  const escaped = bundle
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `export const EMBEDDED_OPENCODE_PLUGIN = \`${escaped}\`;\n`;
}

describe("build-opencode.mjs — baked version helpers", () => {
  let h: Helpers;
  let dir: string;

  beforeEach(async () => {
    h = (await import(SCRIPT)) as Helpers;
    dir = mkdtempSync(join(tmpdir(), "sentinal-bundle-version-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, text: string): string {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  }

  it("readBakedVersion reads the literal from a bundle and from its embedded copy", () => {
    expect(h.readBakedVersion(bakedBundle("1.39.0"))).toBe("1.39.0");
    expect(h.readBakedVersion(embedded(bakedBundle("1.39.0")))).toBe("1.39.0");
  });

  it("readBakedVersion returns null when the define was not applied", () => {
    expect(h.readBakedVersion(UNDEFINED_BUNDLE)).toBeNull();
    expect(h.readBakedVersion("no function here")).toBeNull();
  });

  it("passes when both the bundle and the embedded copy carry the version", () => {
    const b = write("sentinal.mjs", bakedBundle("1.39.0"));
    const e = write("embedded-assets.ts", embedded(bakedBundle("1.39.0")));
    expect(h.verifyBakedVersion("1.39.0", [b, e])).toEqual([]);
  });

  it("fails when the bundle carries the PREVIOUS version (the 1.38.0 bug)", () => {
    const b = write("sentinal.mjs", bakedBundle("1.38.0"));
    const e = write("embedded-assets.ts", embedded(bakedBundle("1.39.0")));
    const problems = h.verifyBakedVersion("1.39.0", [b, e]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(b);
    expect(problems[0]).toContain("1.38.0");
  });

  it("fails when only the embedded copy is stale — binaries ship that one", () => {
    const b = write("sentinal.mjs", bakedBundle("1.39.0"));
    const e = write("embedded-assets.ts", embedded(bakedBundle("1.38.0")));
    const problems = h.verifyBakedVersion("1.39.0", [b, e]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(e);
  });

  it("fails when the define is missing entirely", () => {
    const b = write("sentinal.mjs", UNDEFINED_BUNDLE);
    const problems = h.verifyBakedVersion("1.39.0", [b]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no baked");
  });

  it("fails when a file is missing", () => {
    const missing = join(dir, "nope.mjs");
    const problems = h.verifyBakedVersion("1.39.0", [missing]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(missing);
  });

  it("a version that is only a prefix of the baked one does not pass", () => {
    const b = write("sentinal.mjs", bakedBundle("1.39.0-beta.1"));
    expect(h.verifyBakedVersion("1.39.0", [b])).toHaveLength(1);
  });
});
