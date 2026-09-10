/**
 * `opencode.json` / `opencode.jsonc` merging for `sentinal install opencode`.
 *
 * ⚠️ The merge is ADDITIVE everywhere (`deepMergeAdditive` for permission /
 * agent blocks, add-if-absent for `mcp`): a key the user deleted is re-added
 * on the next install, but a key whose VALUE the user changed is preserved.
 * That asymmetry is load-bearing for the shipped permission defaults — the
 * documented opt-out is "set the value to `allow`", never "delete the line".
 *
 * M7c safety contract (the v1.36.2 H7 pattern):
 *  - a sibling `.bak` (latest-wins) is written before every modify;
 *  - an unparseable config is skipped with a warning — NEVER overwritten,
 *    never "started fresh";
 *  - every cast out of the parsed config is shape-validated first (a string
 *    `plugin`/`instructions` or non-object `mcp` warns and is treated as
 *    empty instead of throwing).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, stripJsoncComments } from "../../utils/shell.js";
import { buildPluginList, deepMergeAdditive } from "./install-shared.js";
import { OPENCODE_LSP_DEFAULT } from "./install-constants.js";
import { EMBEDDED_OC_CONFIG_JSON } from "../embedded-assets.js";

export interface OpenCodeConfigOptions {
  /** Directory holding the config file (cwd for --local, target dir otherwise). */
  configDir: string;
  /** True when installing the embedded `.mjs` plugin rather than the npm package. */
  binary: boolean;
  /** Plugin reference written into `config.plugin`. */
  pluginPath: string;
  /** MCP server block to merge in. */
  mcpServers: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shape-validated read of an array-of-strings config field. */
function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  err(`  ! config.${field} is not an array — ignoring its value`);
  return undefined;
}

/**
 * Merge the managed MCP servers into the user's existing block.
 *
 * ADDITIVE with ONE exception: the `sentinal` entry is always force-updated,
 * because its command carries the installed binary's path — a stale path from
 * a previous install location would break the MCP server outright. The other
 * managed servers (`context7`, `web-search`, `grep-mcp`, `web-fetch`) are
 * added only if ABSENT; existing user values (version pins, `enabled: false`,
 * environment edits) are preserved byte-for-byte.
 */
function mergeMcpServers(
  existing: unknown,
  mcpServers: Record<string, unknown>,
): Record<string, unknown> {
  let existingMcp: Record<string, unknown> = {};
  if (isPlainObject(existing)) {
    existingMcp = existing;
  } else if (existing !== undefined) {
    err("  ! config.mcp is not an object — replacing with managed servers");
  }

  const merged: Record<string, unknown> = { ...existingMcp };
  for (const [key, value] of Object.entries(mcpServers)) {
    if (!(key in merged)) merged[key] = value;
  }
  if ("sentinal" in mcpServers) merged.sentinal = mcpServers.sentinal;
  return merged;
}

/**
 * Create or update the OpenCode config file. Returns the resolved config file
 * path so the caller can name it in the install summary.
 */
export function writeOpenCodeConfig(opts: OpenCodeConfigOptions): string {
  const { configDir, binary, pluginPath, mcpServers } = opts;

  // Parse embedded config to extract permission and agent settings
  const embeddedConfig = JSON.parse(EMBEDDED_OC_CONFIG_JSON) as Record<
    string,
    unknown
  >;
  const permissionConfig = embeddedConfig.permission as
    Record<string, unknown> | undefined;
  const agentConfig = embeddedConfig.agent as
    Record<string, unknown> | undefined;

  let configFile = join(configDir, "opencode.json");
  if (existsSync(join(configDir, "opencode.jsonc")))
    configFile = join(configDir, "opencode.jsonc");

  if (existsSync(configFile)) {
    const originalRaw = readFileSync(configFile, "utf-8");
    let content = originalRaw;
    // ⚠️ JSONC comments are stripped and NOT written back — the .bak below is
    // the recovery path; comment-preserving editing is out of scope.
    if (configFile.endsWith(".jsonc")) content = stripJsoncComments(content);

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(content);
    } catch (e) {
      // Never "start fresh": overwriting would replace the user's config with
      // Sentinal defaults only. Skip and continue — the rest of the install
      // is unaffected; the user fixes the file and re-runs.
      err(
        `  ! Config merge skipped — could not parse ${configFile}: ` +
          `${e instanceof Error ? e.message : String(e)}. File left untouched; ` +
          `fix it and re-run the install.`,
      );
      return configFile;
    }

    // The config.plugin entry is the ONLY load path (OpenCode's directory
    // scan excludes .mjs — see buildPluginList doc). Dedupe to exactly one.
    config.plugin = buildPluginList(
      asStringArray(config.plugin, "plugin"),
      binary,
      pluginPath,
    );
    ok("    Plugin configured");

    config.mcp = mergeMcpServers(config.mcp, mcpServers);
    ok("    MCP servers merged");

    // Deep-merge permission config (adds missing keys, preserves user values)
    if (permissionConfig) {
      config.permission = deepMergeAdditive(
        isPlainObject(config.permission) ? config.permission : {},
        permissionConfig,
      );
      ok("    Permissions merged");
    }

    // Deep-merge agent config (adds missing keys, preserves user values)
    if (agentConfig) {
      config.agent = deepMergeAdditive(
        isPlainObject(config.agent) ? config.agent : {},
        agentConfig,
      );
      ok("    Agent permissions merged");
    }

    // Add .sentinal/rules/ to instructions for project-level rule loading
    const instructions =
      asStringArray(config.instructions, "instructions") ?? [];
    if (!instructions.includes(".sentinal/rules/*.md")) {
      config.instructions = [...instructions, ".sentinal/rules/*.md"];
      ok("    Instructions: .sentinal/rules/*.md added");
    }

    // Back up the pre-write content before modifying. Latest-wins: any prior
    // .bak is overwritten, so it always holds the immediate pre-write bytes.
    writeFileSync(`${configFile}.bak`, originalRaw);
    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    ok("  OpenCode configuration updated");
  } else {
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: buildPluginList(undefined, binary, pluginPath),
          permission: permissionConfig,
          agent: agentConfig,
          instructions: [".sentinal/rules/*.md"],
          mcp: mcpServers,
          lsp: OPENCODE_LSP_DEFAULT,
        },
        null,
        2,
      ) + "\n",
    );
    ok(`  OpenCode configuration created: ${configFile}`);
  }

  return configFile;
}
