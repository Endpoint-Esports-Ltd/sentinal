/**
 * Claude Code installer for `sentinal install claude`.
 *
 * Builds a local marketplace under `MARKETPLACE_DIR`, writes the plugin
 * payload into it (from embedded constants in binary mode, from the source
 * tree otherwise), registers the marketplace with the `claude` CLI, installs
 * the plugin, and points Claude Code's statusline at `sentinal statusline`.
 *
 * ⛔ Extracted from `install.ts` verbatim — behaviour must stay byte-identical
 * to what shipped before the split. This is the user-facing install path.
 *
 * ⚠️ Claude Code reads only the `agent` and `subagentStatusLine` keys out of a
 * plugin-root `settings.json` (plugins reference, *File locations reference*).
 * `configureStatusline()` exists precisely because the plugin file's
 * `statusLine` key does not apply — the statusline has to be written into the
 * user's own `~/.claude/settings.json`.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  info,
  ok,
  err,
  note,
  run,
  commandExists,
  getNodeMajorVersion,
  resolveAssetsDir,
  copyDirRecursive,
  mkdirp,
  stripJsoncComments,
} from "../../utils/shell.js";
import {
  checkChromeDevToolsMcp,
  checkPlaywrightCli,
} from "./install-prereqs.js";
import { isStatuslineActive } from "./statusline.js";
import {
  resolveModelRouting,
  applyModelRouting,
} from "../../config/model-routing.js";
import { DEFAULT_MODEL_ROUTING } from "../../config/types.js";
import { MemoryStore } from "../../memory/store.js";
import {
  MARKETPLACE_DIR,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
} from "./install-constants.js";
import { isBinaryMode, getSentinalBinPath } from "./install-shared.js";
import {
  EMBEDDED_CC_PLUGIN_JSON,
  EMBEDDED_CC_LSP_JSON,
  EMBEDDED_CC_MCP_JSON,
  EMBEDDED_CC_SETTINGS_JSON,
  EMBEDDED_CC_HOOKS_JSON,
  EMBEDDED_CC_AGENTS,
  EMBEDDED_CC_COMMANDS,
  EMBEDDED_CC_RULES,
} from "../embedded-assets.js";

// ─── Claude Code installer ──────────────────────────────────────────────────

export async function installClaudeCode(): Promise<void> {
  console.log(
    "Sentinal for Claude Code — TypeScript/Angular/NestJS Quality Enforcement",
  );
  console.log(
    "=========================================================================",
  );
  console.log("");

  // ── Prerequisites ──

  const nodeMajor = getNodeMajorVersion();
  if (nodeMajor === null) {
    err("ERROR: Node.js is required (v18+). Install from https://nodejs.org");
    process.exit(1);
  }
  if (nodeMajor < 18) {
    err(`ERROR: Node.js 18+ required (found v${nodeMajor})`);
    process.exit(1);
  }
  ok(`[OK] Node.js v${nodeMajor}`);

  if (!commandExists("claude")) {
    err("ERROR: Claude Code CLI is required.");
    console.log("  Install: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
  ok("[OK] Claude Code CLI");

  if (!commandExists("sentinal")) {
    err("ERROR: sentinal binary must be on PATH.");
    console.log(
      "  Hooks use `sentinal hook` subcommands. Ensure PATH includes ~/.bun/bin or ~/.sentinal/bin",
    );
    process.exit(1);
  }
  ok("[OK] sentinal binary on PATH");

  // Optional: browser automation for /spec UI verification. Either tool
  // satisfies the E2E requirement (D11) — both are detect-only.
  checkPlaywrightCli();
  checkChromeDevToolsMcp();

  // ── Remove previous installation ──

  const pluginList = run(["claude", "plugin", "list"]);
  if (
    pluginList.ok &&
    pluginList.stdout.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)
  ) {
    console.log("");
    info("Removing previous Sentinal installation...");
    run([
      "claude",
      "plugin",
      "uninstall",
      `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    ]);
  }

  const marketplaceList = run(["claude", "plugin", "marketplace", "list"]);
  if (marketplaceList.ok && marketplaceList.stdout.includes(MARKETPLACE_NAME)) {
    run(["claude", "plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  }

  // Clean previous marketplace directory
  if (existsSync(MARKETPLACE_DIR)) {
    rmSync(MARKETPLACE_DIR, { recursive: true, force: true });
  }

  // ── Create local marketplace ──

  console.log("");
  info("Creating local marketplace...");

  const pluginDir = join(MARKETPLACE_DIR, "plugins", PLUGIN_NAME);

  mkdirp(join(MARKETPLACE_DIR, ".claude-plugin"));
  mkdirp(pluginDir);

  // Write marketplace manifest
  const marketplaceManifest = {
    name: MARKETPLACE_NAME,
    owner: { name: "Endpoint Esports" },
    metadata: {
      description: "Sentinal quality enforcement plugin for Claude Code",
    },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./plugins/${PLUGIN_NAME}`,
        description:
          "Quality enforcement for TypeScript, Angular, and NestJS projects",
      },
    ],
  };

  writeFileSync(
    join(MARKETPLACE_DIR, ".claude-plugin", "marketplace.json"),
    JSON.stringify(marketplaceManifest, null, 2) + "\n",
  );

  // Copy target assets into the marketplace plugin dir
  if (isBinaryMode()) {
    writeClaudeCodeEmbeddedAssets(pluginDir);
  } else {
    const assetsDir = resolveAssetsDir();
    const claudeTarget = join(assetsDir, "claude-code");
    copyDirRecursive(claudeTarget, pluginDir, {
      exclude: ["install.sh", "uninstall.sh", "tsconfig.json", "dist"],
    });
  }

  // Apply model routing config to plugin files
  try {
    const routingStore = new MemoryStore();
    const routing = resolveModelRouting(routingStore);
    routingStore.close();
    const isNonDefault = (
      Object.keys(DEFAULT_MODEL_ROUTING) as Array<
        keyof typeof DEFAULT_MODEL_ROUTING
      >
    ).some((k) => routing[k] !== DEFAULT_MODEL_ROUTING[k]);
    const { patched } = applyModelRouting([pluginDir], routing);
    if (isNonDefault && patched.length > 0) {
      info(`Applied model routing to ${patched.length} skill files`);
    }
  } catch {
    // Model routing is supplementary — don't fail install
  }

  ok(`[OK] Marketplace created at ${MARKETPLACE_DIR}`);

  // ── Register & install ──

  console.log("");
  info("Registering marketplace...");
  const addResult = run([
    "claude",
    "plugin",
    "marketplace",
    "add",
    MARKETPLACE_DIR,
  ]);
  if (!addResult.ok) {
    err(`Failed to register marketplace: ${addResult.stderr}`);
    process.exit(1);
  }
  ok(`[OK] Marketplace registered: ${MARKETPLACE_NAME}`);

  console.log("");
  info("Installing plugin...");
  const installResult = run([
    "claude",
    "plugin",
    "install",
    `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  ]);
  if (!installResult.ok) {
    err(`Failed to install plugin: ${installResult.stderr}`);
    process.exit(1);
  }
  ok(`[OK] Plugin installed: ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);

  // ── Configure statusline ──

  console.log("");
  info("Configuring statusline...");
  if (configureStatusline()) {
    ok("[OK] Statusline configured (sentinal statusline)");
  } else {
    note("Statusline skipped — another statusline plugin is active.");
  }

  // ── Done ──

  console.log(`\n${"=".repeat(60)}`);
  ok("Sentinal for Claude Code installed successfully!");
  console.log(`${"=".repeat(60)}`);
  console.log(`  Plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  console.log("  Statusline: sentinal statusline (usage stats + context)");
  console.log("  Commands: /sentinal:spec, /sentinal:sync, /sentinal:learn");
  console.log("  Restart Claude Code to activate the plugin.\n");
}

// ─── Statusline configuration ───────────────────────────────────────────────

/** Configure Claude Code's native statusline to use `sentinal statusline`.
 *  Returns true if configured, false if skipped (another plugin active). */
function configureStatusline(): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(stripJsoncComments(raw));
    } catch {
      // If we can't parse existing settings, start fresh
      settings = {};
    }
  } else {
    // Ensure ~/.claude/ directory exists
    mkdirp(join(homedir(), ".claude"));
  }

  // Skip if another statusline plugin is active
  if (!isStatuslineActive(settingsPath)) {
    return false;
  }

  const binPath = getSentinalBinPath();
  settings.statusLine = {
    type: "command",
    command: `${binPath} statusline`,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

// ─── Claude Code embedded asset writer ──────────────────────────────────────

/** Write all Claude Code plugin files from embedded constants into pluginDir. */
function writeClaudeCodeEmbeddedAssets(pluginDir: string): void {
  // .claude-plugin/plugin.json
  mkdirp(join(pluginDir, ".claude-plugin"));
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    EMBEDDED_CC_PLUGIN_JSON,
  );

  // Top-level config files
  writeFileSync(join(pluginDir, ".lsp.json"), EMBEDDED_CC_LSP_JSON);
  writeFileSync(join(pluginDir, "settings.json"), EMBEDDED_CC_SETTINGS_JSON);

  // .mcp.json — patch sentinal server command to use full binary path
  const mcpConfig = JSON.parse(EMBEDDED_CC_MCP_JSON);
  if (mcpConfig.mcpServers?.sentinal) {
    const binPath = getSentinalBinPath();
    mcpConfig.mcpServers.sentinal.command = binPath;
    mcpConfig.mcpServers.sentinal.args = ["mcp-server"];
  }
  writeFileSync(
    join(pluginDir, ".mcp.json"),
    JSON.stringify(mcpConfig, null, 2) + "\n",
  );

  // hooks/hooks.json
  mkdirp(join(pluginDir, "hooks"));
  writeFileSync(join(pluginDir, "hooks", "hooks.json"), EMBEDDED_CC_HOOKS_JSON);

  // agents/*.md
  mkdirp(join(pluginDir, "agents"));
  for (const [name, content] of Object.entries(EMBEDDED_CC_AGENTS) as [
    string,
    string,
  ][]) {
    writeFileSync(join(pluginDir, "agents", name), content);
  }

  // commands/*.md
  mkdirp(join(pluginDir, "commands"));
  for (const [name, content] of Object.entries(EMBEDDED_CC_COMMANDS) as [
    string,
    string,
  ][]) {
    writeFileSync(join(pluginDir, "commands", name), content);
  }

  // rules/*.md
  mkdirp(join(pluginDir, "rules"));
  for (const [name, content] of Object.entries(EMBEDDED_CC_RULES) as [
    string,
    string,
  ][]) {
    writeFileSync(join(pluginDir, "rules", name), content);
  }
}
