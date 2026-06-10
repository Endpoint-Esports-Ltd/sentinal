/**
 * Plugin module export-surface guard.
 *
 * ⛔ OpenCode's plugin runner (upstream packages/opencode/src/plugin/index.ts,
 * `getLegacyPlugins`) invokes EVERY function export of a plugin module as a
 * plugin factory with PluginInput, and pushes each return value into its
 * hooks array. Three production incidents on 2026-06-10 trace to extra
 * exports on targets/opencode/plugins/sentinal.ts:
 *
 *   - `parseBinaryVersion` (exported for tests) was invoked with PluginInput
 *     → `input.trim()` → "stdout.trim is not a function" → ENTIRE plugin
 *     failed to load (OSX, v1.31.3)
 *   - after hardening, it returned null; `ensureDashboardForTest` returned
 *     undefined — both pushed into hooks → "plugin config hook failed:
 *     undefined/null is not an object (evaluating 'j.config')" → later hook
 *     triggers threw → OpenCode died silently after init (v1.31.4)
 *   - `ensureDashboardForTest`-as-plugin also ran a spurious dashboard
 *     ensure per instance (the doubled "dashboard ensure" log lines since
 *     v1.31.0)
 *
 * This test imports the REAL shipped artifact (the embedded plugin bundle)
 * and asserts the export surface is exactly the plugin function — nothing
 * else for OpenCode to mis-invoke. Non-function exports are worse still:
 * getLegacyPlugins throws "Plugin export is not a function".
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("shipped OpenCode plugin export surface", () => {
  it("exports exactly the plugin function (default + SentinalPlugin, same reference)", async () => {
    const { EMBEDDED_OPENCODE_PLUGIN } = await import(
      "../cli/embedded-assets.js"
    );
    const dir = mkdtempSync(join(tmpdir(), "sentinal-export-guard-"));
    const file = join(dir, "plugin.mjs");
    writeFileSync(file, EMBEDDED_OPENCODE_PLUGIN);
    try {
      const mod = (await import(file)) as Record<string, unknown>;
      const keys = Object.keys(mod).sort();
      expect(keys).toEqual(["SentinalPlugin", "default"]);
      expect(typeof mod.SentinalPlugin).toBe("function");
      // Same reference — OpenCode dedupes by value, so this yields ONE instance
      expect(mod.default).toBe(mod.SentinalPlugin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
