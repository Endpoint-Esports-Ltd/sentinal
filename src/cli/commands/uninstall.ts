/**
 * Sentinal Uninstall Command
 *
 * Uninstalls Sentinal quality enforcement plugin from Claude Code and/or OpenCode.
 * Replaces uninstall.sh, targets/claude-code/uninstall.sh, and targets/opencode/uninstall.sh.
 *
 * Usage:
 *   sentinal uninstall              Auto-detect installed plugins, prompt if both found
 *   sentinal uninstall claude       Uninstall from Claude Code only
 *   sentinal uninstall opencode     Uninstall from OpenCode only
 *   sentinal uninstall both         Uninstall from both assistants
 *   sentinal uninstall --local      Uninstall OpenCode from current project (not global)
 */

import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  colors,
  info,
  ok,
  err,
  note,
  run,
  commandExists,
  resolveXdgConfig,
  removeFileIfExists,
  removeDirIfExists,
  removeDirIfEmpty,
  promptMenu,
  stripJsoncComments,
} from "../../utils/shell.js";
import { detectShell, getShellConfigPath, removeBlock } from "./shell-init.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_DIR = join(homedir(), ".claude", "plugins", "sentinal-marketplace");
const MARKETPLACE_NAME = "sentinal-marketplace";
const PLUGIN_NAME = "sentinal";

/** Command files installed by Sentinal (sub-phases removed — now skills). */
const COMMAND_FILES = ["spec", "sync", "learn"];

/** Hardcoded list of rule files installed by Sentinal. */
const RULE_FILES = [
  "standards-typescript",
  "standards-angular",
  "standards-nestjs",
  "standards-frontend",
  "standards-backend",
];

/** MCP server keys managed by Sentinal. */
const MCP_KEYS = ["context7", "web-search", "grep-mcp", "web-fetch", "sentinal"];

/** Agent files installed by Sentinal. */
const AGENT_FILES = ["plan-reviewer.md", "spec-reviewer.md"];

/** Skill directory names installed by Sentinal. */
const SKILL_DIRS = ["spec-plan", "spec-implement", "spec-verify", "spec-bugfix-plan", "spec-bugfix-verify"];

/** All possible plugin filenames (deployed via different install paths). */
const PLUGIN_FILENAMES = ["sentinal.mjs", "sentinal.ts", "sentinal.js"];

/** All possible plugin path strings that may appear in the opencode config plugin array. */
const PLUGIN_PATH_PATTERNS = [
  "@endpoint/sentinal/opencode-plugin",
  "./plugins/sentinal.mjs",
  "./plugins/sentinal.ts",
  "./plugins/sentinal.js",
];

// ─── Options ────────────────────────────────────────────────────────────────

export interface UninstallOptions {
  /** Uninstall OpenCode from current project instead of global. */
  local?: boolean;
  /** When true, preserve binary, npm package, shell integration, and AGENTS.md. */
  preserveBinary?: boolean;
}

// ─── Register command ───────────────────────────────────────────────────────

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall [target]")
    .description("Uninstall Sentinal from an AI assistant (claude, opencode, both)")
    .option("--local", "Uninstall OpenCode plugin from current project instead of global")
    .option("--remove-binary", "Also remove the sentinal binary, npm package, and shell integration")
    .action(async (target?: string, opts?: { local?: boolean; removeBinary?: boolean }) => {
      try {
        const uninstallOpts: UninstallOptions = {
          local: opts?.local,
          preserveBinary: !opts?.removeBinary,
        };
        await uninstallDispatcher(target, uninstallOpts);
      } catch (e) {
        err(`Uninstall failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}

// ─── Detection ──────────────────────────────────────────────────────────────

export interface InstalledTargets {
  claude: boolean;
  opencode: boolean;
}

/**
 * Detect which assistants have Sentinal installed by checking for artifacts.
 * Claude: checks for marketplace directory at ~/.claude/plugins/sentinal-marketplace.
 * OpenCode: checks for plugin files, agents, or skills in XDG config.
 *
 * @param overrides - Optional path overrides for testability.
 */
export function detectInstalledTargets(overrides?: {
  marketplaceDir?: string;
  xdgConfig?: string;
}): InstalledTargets {
  const xdgConfig = overrides?.xdgConfig ?? resolveXdgConfig();
  const marketplaceDir = overrides?.marketplaceDir ?? MARKETPLACE_DIR;
  const opencodePluginsDir = join(xdgConfig, "opencode", "plugins");

  const claude = existsSync(marketplaceDir);
  const opencode =
    PLUGIN_FILENAMES.some((f) => existsSync(join(opencodePluginsDir, f)))
    || AGENT_FILES.some((f) => existsSync(join(xdgConfig, "opencode", "agents", f)))
    || SKILL_DIRS.some((d) => existsSync(join(xdgConfig, "opencode", "skills", d)));

  return { claude, opencode };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function uninstallDispatcher(
  target?: string,
  opts?: UninstallOptions,
): Promise<void> {
  const local = opts?.local ?? false;
  const preserveBinary = opts?.preserveBinary ?? true;
  const ocOpts: UninstallOptions = { local, preserveBinary };

  // Explicit target
  if (target) {
    switch (target.toLowerCase()) {
      case "claude":
      case "claude-code":
        await uninstallClaudeCode();
        return;
      case "opencode":
        await uninstallOpenCode(ocOpts);
        return;
      case "both":
        await uninstallClaudeCode();
        console.log("");
        await uninstallOpenCode(ocOpts);
        return;
      default:
        err(`Unknown target: ${target}`);
        console.log("Valid targets: claude, opencode, both");
        process.exit(1);
    }
  }

  // Auto-detect mode — detect INSTALLED artifacts, not CLI binaries
  console.log("Sentinal — Uninstaller");
  console.log("======================");
  console.log("");

  info("Detecting Sentinal installations...");

  const { claude: hasClaude, opencode: hasOpencode } = detectInstalledTargets();

  if (hasClaude) ok("  Claude Code plugin found");
  else info("  ! Claude Code plugin not found");

  if (hasOpencode) ok("  OpenCode plugin found");
  else info("  ! OpenCode plugin not found");

  console.log("");

  if (!hasClaude && !hasOpencode) {
    info("No Sentinal installations detected.");
    console.log("Nothing to uninstall.");
    return;
  }

  if (hasClaude && !hasOpencode) {
    info("Only Claude Code installation detected.");
    await uninstallClaudeCode();
  } else if (!hasClaude && hasOpencode) {
    info("Only OpenCode installation detected.");
    await uninstallOpenCode(ocOpts);
  } else {
    // Both found — interactive prompt
    const choice = await promptMenu(
      `${colors.yellow}Both Claude Code and OpenCode installations detected.${colors.nc}\n\nSelect uninstallation target:`,
      ["Claude Code only", "OpenCode only", "Both assistants", "Cancel"],
    );
    console.log("");

    switch (choice) {
      case 1:
        await uninstallClaudeCode();
        break;
      case 2:
        await uninstallOpenCode(ocOpts);
        break;
      case 3:
        await uninstallClaudeCode();
        console.log("");
        await uninstallOpenCode(ocOpts);
        break;
      default:
        console.log("Uninstallation cancelled.");
        return;
    }
  }

  console.log("");
  ok("Uninstallation complete!");
}

// ─── Claude Code uninstaller ────────────────────────────────────────────────

export async function uninstallClaudeCode(): Promise<void> {
  console.log("Sentinal for Claude Code — Uninstaller");
  console.log("=======================================");
  console.log("");

  if (!commandExists("claude")) {
    throw new Error("Claude Code CLI not found. Cannot uninstall Claude Code plugin.");
  }

  let foundSomething = false;

  // ── Uninstall plugin ──

  const pluginList = run(["claude", "plugin", "list"]);
  if (pluginList.ok && pluginList.stdout.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) {
    info("Uninstalling plugin...");
    run(["claude", "plugin", "uninstall", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    ok(`[OK] Plugin uninstalled: ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    foundSomething = true;
  } else {
    console.log("[--] Plugin not installed, skipping.");
  }

  // ── Remove marketplace ──

  const marketplaceList = run(["claude", "plugin", "marketplace", "list"]);
  if (marketplaceList.ok && marketplaceList.stdout.includes(MARKETPLACE_NAME)) {
    info("Removing marketplace...");
    run(["claude", "plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    ok(`[OK] Marketplace removed: ${MARKETPLACE_NAME}`);
    foundSomething = true;
  } else {
    console.log("[--] Marketplace not registered, skipping.");
  }

  // ── Clean up directory ──

  if (existsSync(MARKETPLACE_DIR)) {
    info("Removing marketplace directory...");
    removeDirIfExists(MARKETPLACE_DIR);
    ok(`[OK] Removed: ${MARKETPLACE_DIR}`);
    foundSomething = true;
  } else {
    console.log("[--] Marketplace directory not found, skipping.");
  }

  // ── Done ──

  console.log("");
  if (foundSomething) {
    console.log("=======================================");
    ok("  Sentinal for Claude Code uninstalled.");
    console.log("=======================================");
    console.log("");
    console.log("  Restart Claude Code to complete removal.");
  } else {
    console.log("  Nothing to uninstall — Sentinal was not found.");
  }
  console.log("");
}

// ─── OpenCode uninstaller ───────────────────────────────────────────────────

export async function uninstallOpenCode(opts: UninstallOptions = {}): Promise<void> {
  const local = opts.local ?? false;
  const preserveBinary = opts.preserveBinary ?? true;

  console.log("Sentinal for OpenCode — Uninstaller");
  console.log("====================================");
  console.log("");

  // ── Determine target directories ──

  const xdgConfig = resolveXdgConfig();
  const globalConfig = join(xdgConfig, "opencode");

  let targetDir: string;
  let pluginsDir: string;
  let commandsDir: string;
  let rulesDir: string;

  if (local) {
    targetDir = join(process.cwd(), ".opencode");
    pluginsDir = join(targetDir, "plugins");
    commandsDir = join(targetDir, "commands");
    rulesDir = join(targetDir, "rules");
    note(`Uninstalling from current project: ${targetDir}`);
  } else {
    targetDir = globalConfig;
    pluginsDir = join(globalConfig, "plugins");
    commandsDir = join(globalConfig, "commands");
    rulesDir = join(globalConfig, "rules");
    note(`Uninstalling globally: ${targetDir}`);
  }

  console.log("");

  // ── Remove plugin files (all known variants) ──

  info("Removing Sentinal plugin...");
  let pluginRemoved = false;
  for (const filename of PLUGIN_FILENAMES) {
    if (removeFileIfExists(join(pluginsDir, filename))) {
      ok(`  Removed ${filename}`);
      pluginRemoved = true;
    }
  }
  if (!pluginRemoved) {
    info("  ! No plugin files found");
  }

  // ── Remove commands ──

  info("Removing commands...");
  if (existsSync(commandsDir)) {
    for (const cmd of COMMAND_FILES) {
      if (removeFileIfExists(join(commandsDir, `${cmd}.md`))) {
        ok(`    ${cmd}.md`);
      }
    }
  }

  // ── Remove rules ──

  info("Removing rules...");
  if (existsSync(rulesDir)) {
    for (const rule of RULE_FILES) {
      if (removeFileIfExists(join(rulesDir, `${rule}.md`))) {
        ok(`    ${rule}.md`);
      }
    }
  }

  // ── Remove agents ──

  const agentsDir = join(targetDir, "agents");
  info("Removing agents...");
  for (const agent of AGENT_FILES) {
    if (removeFileIfExists(join(agentsDir, agent))) {
      ok(`    ${agent}`);
    }
  }

  // ── Remove skills ──

  const skillsDir = join(targetDir, "skills");
  info("Removing skills...");
  for (const skill of SKILL_DIRS) {
    const skillDir = join(skillsDir, skill);
    if (existsSync(skillDir)) {
      removeDirIfExists(skillDir);
      ok(`    ${skill}/`);
    }
  }

  // ── Remove global package ──

  if (!preserveBinary) {
    info("Removing @endpoint/sentinal (global)...");
    if (commandExists("bun")) {
      run(["bun", "remove", "-g", "@endpoint/sentinal"]);
      ok("  @endpoint/sentinal removed globally");
    } else {
      info("  ! bun not available, skipping global package removal");
    }
  }

  // ── Remove AGENTS.md (global only, if ours, and not during update) ──

  if (!local && !preserveBinary) {
    info("Removing AGENTS.md...");
    const agentsPath = join(targetDir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      const content = readFileSync(agentsPath, "utf-8");
      if (content.includes("Sentinal Global Standards")) {
        unlinkSync(agentsPath);
        ok("  AGENTS.md removed");
      } else {
        info("  ! AGENTS.md not created by Sentinal, skipping");
      }
    }
  }

  // ── Clean opencode config ──

  info("Cleaning opencode config...");

  // Build the full set of plugin paths to match (static patterns + absolute paths)
  const pluginPathsToRemove = new Set(PLUGIN_PATH_PATTERNS);
  for (const filename of PLUGIN_FILENAMES) {
    pluginPathsToRemove.add(join(pluginsDir, filename));
    if (local) {
      pluginPathsToRemove.add(`.opencode/plugins/${filename}`);
    }
  }

  const configDir = local ? process.cwd() : targetDir;

  // Find config file
  let configFile: string | null = null;
  if (existsSync(join(configDir, "opencode.json"))) {
    configFile = join(configDir, "opencode.json");
  } else if (existsSync(join(configDir, "opencode.jsonc"))) {
    configFile = join(configDir, "opencode.jsonc");
  }

  if (configFile) {
    let content = readFileSync(configFile, "utf-8");

    // Strip comments for .jsonc
    if (configFile.endsWith(".jsonc")) {
      content = stripJsoncComments(content);
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(content);
    } catch {
      info(`  ! Config has invalid JSON, skipping: ${configFile}`);
      config = null as unknown as Record<string, unknown>;
    }

    if (config) {
      // Remove all sentinal plugin path variants from plugin array
      const plugins = (config.plugin as string[]) ?? [];
      config.plugin = plugins.filter((p) => !pluginPathsToRemove.has(p) && !p.includes("sentinal"));

      // Remove sentinal MCP server keys
      const mcp = (config.mcp as Record<string, unknown>) ?? {};
      for (const key of MCP_KEYS) {
        delete mcp[key];
      }
      config.mcp = mcp;

      // Remove sentinal permission entries (skill, edit rules for plan files)
      const perm = config.permission as Record<string, unknown> | undefined;
      if (perm) {
        delete perm.skill;
        if (typeof perm.edit === "object" && perm.edit) {
          const edit = perm.edit as Record<string, string>;
          for (const key of Object.keys(edit)) {
            if (key.includes("docs/plans")) delete edit[key];
          }
          if (Object.keys(edit).length <= 1) delete perm.edit; // only "*" left
        }
        if (Object.keys(perm).length === 0) delete config.permission;
      }

      // Remove sentinal agent config entries
      const agents = config.agent as Record<string, Record<string, unknown>> | undefined;
      if (agents) {
        for (const [name, agentCfg] of Object.entries(agents)) {
          const taskPerm = (agentCfg.permission as Record<string, unknown>)?.task as Record<string, string> | undefined;
          if (taskPerm) {
            for (const key of [...AGENT_FILES.map(f => f.replace(".md", "")), "plan-reviewer", "spec-reviewer"]) {
              delete taskPerm[key];
            }
          }
        }
      }

      // Check if config is now effectively empty
      if (isConfigEffectivelyEmpty(config)) {
        unlinkSync(configFile);
        ok(`  Config was Sentinal-only, removed: ${configFile}`);
      } else {
        writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
        ok("  Sentinal entries removed from config");
      }
    }
  } else {
    info("  ! No opencode config found");
  }

  // ── Clean up empty directories ──

  info("Cleaning up empty directories...");
  for (const dir of [pluginsDir, commandsDir, rulesDir, agentsDir, skillsDir]) {
    removeDirIfEmpty(dir);
  }
  ok("  Cleanup complete");

  // ── Remove shell integration and binary (global only, full removal) ──

  if (!local && !preserveBinary) {
    removeShellIntegration();
    removeBinary();
  }

  // ── Done ──

  console.log("");
  console.log(`${colors.green}${"=".repeat(68)}${colors.nc}`);
  ok("  Sentinal for OpenCode uninstalled successfully!");
  console.log(`${colors.green}${"=".repeat(68)}${colors.nc}`);
  console.log("");
}

// ─── Shell & binary cleanup ─────────────────────────────────────────────────

/** Remove the sentinal managed block from the user's shell config file. */
function removeShellIntegration(): void {
  info("Removing shell integration...");
  const shell = detectShell();
  if (!shell) {
    info("  ! Could not detect shell, skipping");
    return;
  }

  const configPath = getShellConfigPath(shell);
  if (!existsSync(configPath)) {
    info("  ! Shell config not found, skipping");
    return;
  }

  const existing = readFileSync(configPath, "utf-8");
  const result = removeBlock(existing);
  if (result) {
    writeFileSync(configPath, result);
    ok(`  Removed PATH, alias, and completions from ${configPath}`);
  } else {
    info("  ! No sentinal block found in shell config");
  }
}

/** Remove the sentinal binary from ~/.sentinal/bin/. */
function removeBinary(): void {
  const binDir = join(homedir(), ".sentinal", "bin");
  const binPath = join(binDir, "sentinal");

  info("Removing sentinal binary...");
  if (removeFileIfExists(binPath)) {
    ok(`  Removed ${binPath}`);
    removeDirIfEmpty(binDir);
  } else {
    info("  ! Binary not found");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if an opencode config is effectively empty after removing Sentinal entries.
 * Returns true if only $schema, empty plugin, empty mcp, and lsp remain.
 */
function isConfigEffectivelyEmpty(config: Record<string, unknown>): boolean {
  const plugins = (config.plugin as string[]) ?? [];
  const mcp = (config.mcp as Record<string, unknown>) ?? {};
  const knownKeys = new Set(["$schema", "plugin", "mcp", "lsp", "permission", "agent"]);
  const hasExtraKeys = Object.keys(config).some((k) => !knownKeys.has(k));

  return plugins.length === 0 && Object.keys(mcp).length === 0 && !hasExtraKeys;
}
