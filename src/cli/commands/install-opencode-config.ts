/**
 * `opencode.json` / `opencode.jsonc` merging for `sentinal install opencode`.
 *
 * ⛔ Extracted from `install.ts` verbatim — behaviour must stay byte-identical
 * to what shipped before the split.
 *
 * ⚠️ The merge is ADDITIVE (`deepMergeAdditive`): a key the user deleted is
 * re-added on the next install, but a key whose VALUE the user changed is
 * preserved. That asymmetry is load-bearing for the shipped permission
 * defaults — the documented opt-out is "set the value to `allow`", never
 * "delete the line".
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, stripJsoncComments } from "../../utils/shell.js";
import { buildPluginList, deepMergeAdditive } from "./install-shared.js";
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
    let content = readFileSync(configFile, "utf-8");
    if (configFile.endsWith(".jsonc")) content = stripJsoncComments(content);

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(content);
    } catch {
      err(`x Config has invalid JSON: ${configFile}`);
      process.exit(1);
      return configFile; // unreachable but satisfies TypeScript
    }

    // The config.plugin entry is the ONLY load path (OpenCode's directory
    // scan excludes .mjs — see buildPluginList doc). Dedupe to exactly one.
    config.plugin = buildPluginList(
      config.plugin as string[] | undefined,
      binary,
      pluginPath,
    );
    ok("    Plugin configured");

    const existingMcp = (config.mcp as Record<string, unknown>) ?? {};
    config.mcp = { ...mcpServers, ...existingMcp, ...mcpServers };
    ok("    MCP servers merged");

    // Deep-merge permission config (adds missing keys, preserves user values)
    if (permissionConfig) {
      config.permission = deepMergeAdditive(
        (config.permission as Record<string, unknown>) ?? {},
        permissionConfig,
      );
      ok("    Permissions merged");
    }

    // Deep-merge agent config (adds missing keys, preserves user values)
    if (agentConfig) {
      config.agent = deepMergeAdditive(
        (config.agent as Record<string, unknown>) ?? {},
        agentConfig,
      );
      ok("    Agent permissions merged");
    }

    // Add .sentinal/rules/ to instructions for project-level rule loading
    const instructions = (config.instructions as string[]) ?? [];
    if (!instructions.includes(".sentinal/rules/*.md")) {
      config.instructions = [...instructions, ".sentinal/rules/*.md"];
      ok("    Instructions: .sentinal/rules/*.md added");
    }

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
          lsp: {
            typescript: { command: ["typescript-language-server", "--stdio"] },
          },
        },
        null,
        2,
      ) + "\n",
    );
    ok(`  OpenCode configuration created: ${configFile}`);
  }

  return configFile;
}
