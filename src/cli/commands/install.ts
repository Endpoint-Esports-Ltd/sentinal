/**
 * Sentinal Install Command
 *
 * Installs Sentinal quality enforcement plugin for Claude Code and/or OpenCode.
 * Replaces install.sh, targets/claude-code/install.sh, and targets/opencode/install.sh.
 *
 * Usage:
 *   sentinal install              Auto-detect assistants, prompt if both found
 *   sentinal install claude       Install for Claude Code only
 *   sentinal install opencode     Install for OpenCode only
 *   sentinal install both         Install for both assistants
 *   sentinal install --local      Install OpenCode to current project (not global)
 */

import type { Command } from "commander";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  cpSync,
  rmSync,
} from "node:fs";
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
  getNodeMajorVersion,
  resolveXdgConfig,
  resolveAssetsDir,
  resolveSentinalRoot,
  copyDirRecursive,
  mkdirp,
  promptMenu,
  stripJsoncComments,
} from "../../utils/shell.js";
import { greet } from "./greet.js";
import { detectShell, applyShellInit } from "./shell-init.js";
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
  MCP_SERVERS_OPENCODE,
  AGENTS_MD_GLOBAL,
  AGENTS_MD_LOCAL_TEMPLATE,
  AGENTS_MD_APPEND,
} from "./install-constants.js";
import {
  EMBEDDED_OPENCODE_PLUGIN,
  EMBEDDED_COMMANDS,
  EMBEDDED_RULES,
  EMBEDDED_OC_AGENTS,
  EMBEDDED_OC_SKILLS,
  EMBEDDED_OC_CONFIG_JSON,
  EMBEDDED_CC_PLUGIN_JSON,
  EMBEDDED_CC_LSP_JSON,
  EMBEDDED_CC_MCP_JSON,
  EMBEDDED_CC_SETTINGS_JSON,
  EMBEDDED_CC_HOOKS_JSON,
  EMBEDDED_CC_AGENTS,
  EMBEDDED_CC_COMMANDS,
  EMBEDDED_CC_RULES,
} from "../embedded-assets.js";

// ─── Register command ───────────────────────────────────────────────────────

export function registerInstallCommand(program: Command): void {
  program
    .command("install [target]")
    .description(
      "Install Sentinal for an AI assistant (claude, opencode, both)",
    )
    .option(
      "--local",
      "Install OpenCode plugin to current project instead of global",
    )
    .option(
      "--bundled",
      "Use bundled .js plugin file instead of npm package (for offline/airgapped environments)",
    )
    .action(
      async (
        target?: string,
        opts?: { local?: boolean; bundled?: boolean },
      ) => {
        try {
          await installDispatcher(target, opts);
        } catch (e) {
          err(`Install failed: ${(e as Error).message}`);
          process.exit(1);
        }
      },
    );
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function installDispatcher(
  target?: string,
  opts?: { local?: boolean; bundled?: boolean },
): Promise<void> {
  const local = opts?.local ?? false;
  const bundled = opts?.bundled ?? false;

  // Explicit target
  if (target) {
    switch (target.toLowerCase()) {
      case "claude":
      case "claude-code":
        await installClaudeCode();
        return;
      case "opencode":
        await installOpenCode(local, bundled);
        return;
      case "both":
        await installClaudeCode();
        console.log("");
        await installOpenCode(local, bundled);
        return;
      default:
        err(`Unknown target: ${target}`);
        console.log("Valid targets: claude, opencode, both");
        process.exit(1);
    }
  }

  // Auto-detect mode
  greet();
  console.log("");

  info("Detecting AI assistants...");
  const hasClaude = commandExists("claude");
  const hasOpencode = commandExists("opencode");

  if (hasClaude) ok("  Claude Code found");
  else info("  ! Claude Code not found");

  if (hasOpencode) ok("  OpenCode found");
  else info("  ! OpenCode not found");

  console.log("");

  if (!hasClaude && !hasOpencode) {
    err("Error: No AI assistant detected");
    console.log("");
    console.log("Please install at least one of:");
    console.log("  - Claude Code: https://claude.com/download");
    console.log("  - OpenCode: https://opencode.ai");
    process.exit(1);
  }

  if (hasClaude && !hasOpencode) {
    info("Only Claude Code detected. Installing for Claude Code...");
    await installClaudeCode();
  } else if (!hasClaude && hasOpencode) {
    info("Only OpenCode detected. Installing for OpenCode...");
    await installOpenCode(local, bundled);
  } else {
    // Both found — interactive prompt
    const choice = await promptMenu(
      `${colors.yellow}Both Claude Code and OpenCode detected.${colors.nc}\n\nSelect installation target:`,
      ["Claude Code only", "OpenCode only", "Both assistants", "Cancel"],
    );
    console.log("");

    switch (choice) {
      case 1:
        await installClaudeCode();
        break;
      case 2:
        await installOpenCode(local, bundled);
        break;
      case 3:
        await installClaudeCode();
        console.log("");
        await installOpenCode(local, bundled);
        break;
      default:
        console.log("Installation cancelled.");
        return;
    }
  }

  // ── Project symlinks for .sentinal/ canonical paths ──
  setupProjectSymlinks();

  // ── Shell integration ──
  setupShellIntegration();

  console.log("");
  ok("Installation complete!");
}

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
    const isNonDefault = (Object.keys(DEFAULT_MODEL_ROUTING) as Array<keyof typeof DEFAULT_MODEL_ROUTING>).some(k => routing[k] !== DEFAULT_MODEL_ROUTING[k]);
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
    note(
      "Statusline skipped — another statusline plugin is active.",
    );
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

// ─── Binary mode detection ──────────────────────────────────────────────────

/** True when running from compiled binary (no source tree / npm package). */
function isBinaryMode(): boolean {
  return (process.argv[1] ?? "").startsWith("/$bunfs/");
}

/** Get the full path to the sentinal binary (for MCP server config). */
function getSentinalBinPath(): string {
  const installed = join(homedir(), ".sentinal", "bin", "sentinal");
  if (existsSync(installed)) return installed;
  return "sentinal"; // fallback to PATH
}

// ─── OpenCode installer ─────────────────────────────────────────────────────

export async function installOpenCode(
  local: boolean,
  bundled: boolean = false,
): Promise<void> {
  greet();
  note("  for OpenCode");
  console.log("");

  const binary = isBinaryMode() || bundled;

  // ── Prerequisites ──

  info("Checking prerequisites...");

  if (!commandExists("opencode")) {
    err("x OpenCode not found");
    console.log("  Install: curl -fsSL https://opencode.ai/install | bash");
    process.exit(1);
  }
  ok("  OpenCode found");

  if (!binary) {
    if (!commandExists("bun")) {
      err("x Bun not found");
      console.log("  Install from https://bun.sh");
      process.exit(1);
    }
    ok("  Bun found");
  }

  if (!commandExists("node")) {
    err("x Node.js not found");
    console.log("  Install Node.js 18+ from https://nodejs.org");
    process.exit(1);
  }
  ok("  Node.js found");
  console.log("");

  // ── Determine target directories ──
  const xdgConfig = resolveXdgConfig();
  const globalConfig = join(xdgConfig, "opencode");
  const targetDir = local ? join(process.cwd(), ".opencode") : globalConfig;
  const commandsDir = join(targetDir, "commands");
  const rulesDir = join(targetDir, "rules");
  const pluginsDir = join(targetDir, "plugins");

  note(`Installing ${local ? "to current project" : "globally"}: ${targetDir}`);
  console.log("");

  // ── Install plugin ──

  if (binary) {
    // Binary mode: extract embedded plugin from compiled binary
    info("Extracting embedded plugin...");
    mkdirp(pluginsDir);
    writeFileSync(join(pluginsDir, "sentinal.mjs"), EMBEDDED_OPENCODE_PLUGIN);
    ok("  Plugin extracted to plugins/sentinal.mjs");
  } else {
    // NPM mode: install package globally, plugin loads via package reference
    info("Installing @endpoint/sentinal globally...");
    const npmrcPath = join(homedir(), ".npmrc");
    let hasRegistry = false;
    if (existsSync(npmrcPath))
      hasRegistry = readFileSync(npmrcPath, "utf-8").includes(
        "@endpoint:registry",
      );
    if (!hasRegistry) {
      err("x Scoped registry not configured for @endpoint packages");
      console.log(
        "  Add to ~/.npmrc: @endpoint:registry=https://npm.cloud.endpoint.gg/",
      );
      process.exit(1);
    }
    if (commandExists("sentinal")) {
      ok("  @endpoint/sentinal already installed globally");
    } else {
      const installResult = run(["bun", "add", "-g", "@endpoint/sentinal"]);
      if (!installResult.ok) {
        err(`Failed to install: ${installResult.stderr}`);
        process.exit(1);
      }
      ok("  @endpoint/sentinal installed globally");
    }
    if (!commandExists("sentinal"))
      info(
        '  ! sentinal not in PATH — add: export PATH="$HOME/.bun/bin:$PATH"',
      );
  }

  // ── Install flat asset dirs (commands, rules, agents) ──

  const agentsDir = join(targetDir, "agents");
  const skillsDir = join(targetDir, "skills");
  const flatDirs = [
    {
      label: "commands",
      dest: commandsDir,
      embedded: EMBEDDED_COMMANDS,
      src: "commands",
    },
    { label: "rules", dest: rulesDir, embedded: EMBEDDED_RULES, src: "rules" },
    {
      label: "agents",
      dest: agentsDir,
      embedded: EMBEDDED_OC_AGENTS,
      src: "agents",
    },
  ];
  for (const { label, dest, embedded, src } of flatDirs) {
    info(`Installing ${label}...`);
    mkdirp(dest);
    if (binary) {
      for (const [name, content] of Object.entries(embedded) as [
        string,
        string,
      ][]) {
        writeFileSync(join(dest, name), content);
        ok(`    ${name}`);
      }
    } else {
      const srcDir = join(resolveAssetsDir(), "opencode", src);
      for (const file of readdirSyncSafe(srcDir).filter((f) =>
        f.endsWith(".md"),
      )) {
        copyFileSync(join(srcDir, file), join(dest, file));
        ok(`    ${file}`);
      }
    }
  }

  // ── Install skills (nested dirs: skills/<name>/SKILL.md) ──

  info("Installing skills...");
  mkdirp(skillsDir);
  if (binary) {
    for (const [path, content] of Object.entries(EMBEDDED_OC_SKILLS) as [
      string,
      string,
    ][]) {
      const dir = join(skillsDir, path.replace("/SKILL.md", ""));
      mkdirp(dir);
      writeFileSync(join(dir, "SKILL.md"), content);
      ok(`    ${path}`);
    }
  } else {
    const srcSkills = join(resolveAssetsDir(), "opencode", "skills");
    for (const dir of readdirSyncSafe(srcSkills)) {
      const skillMd = join(srcSkills, dir, "SKILL.md");
      if (existsSync(skillMd)) {
        mkdirp(join(skillsDir, dir));
        copyFileSync(skillMd, join(skillsDir, dir, "SKILL.md"));
        ok(`    ${dir}/SKILL.md`);
      }
    }
  }

  // ── AGENTS.md ──

  info("Creating AGENTS.md...");
  if (!local) {
    writeFileSync(join(targetDir, "AGENTS.md"), AGENTS_MD_GLOBAL);
    ok("  Global AGENTS.md created");
  } else {
    const agentsPath = join(process.cwd(), "AGENTS.md");
    if (existsSync(agentsPath)) {
      writeFileSync(
        agentsPath,
        readFileSync(agentsPath, "utf-8") + AGENTS_MD_APPEND,
      );
      ok("  Updated existing AGENTS.md");
    } else {
      writeFileSync(agentsPath, AGENTS_MD_LOCAL_TEMPLATE);
      ok("  Created AGENTS.md");
    }
  }

  // ── opencode config ──

  info("Configuring OpenCode...");

  const pluginPath = binary
    ? "./plugins/sentinal.mjs"
    : "@endpoint/sentinal/opencode-plugin";

  // In binary mode, use absolute binary path for MCP server command
  const mcpServers = binary
    ? {
        ...MCP_SERVERS_OPENCODE,
        sentinal: {
          type: "local" as const,
          command: [getSentinalBinPath(), "mcp-server"],
        },
      }
    : MCP_SERVERS_OPENCODE;

  // Parse embedded config to extract permission and agent settings
  const embeddedConfig = JSON.parse(EMBEDDED_OC_CONFIG_JSON) as Record<
    string,
    unknown
  >;
  const permissionConfig = embeddedConfig.permission as
    | Record<string, unknown>
    | undefined;
  const agentConfig = embeddedConfig.agent as
    | Record<string, unknown>
    | undefined;

  const configDir = local ? process.cwd() : targetDir;
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
      return; // unreachable but satisfies TypeScript
    }

    // Remove any old sentinal plugin paths, then add the new one
    const plugins = ((config.plugin as string[]) ?? []).filter(
      (p) => !p.includes("sentinal"),
    );
    config.plugin = [...plugins, pluginPath];
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
          plugin: [pluginPath],
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

  // ── Success ──

  console.log(`\n${colors.green}${"=".repeat(60)}${colors.nc}`);
  ok("Sentinal for OpenCode installed successfully!");
  console.log(`${colors.green}${"=".repeat(60)}${colors.nc}`);
  note("Installed:");
  console.log(
    `  Plugin:   ${pluginPath}${binary ? " (embedded)" : " (npm package)"}`,
  );
  console.log(`  Commands: ${commandsDir}/*.md`);
  console.log(`  Rules:    ${rulesDir}/*.md`);
  console.log(`  Agents:   ${agentsDir}/*.md`);
  console.log(`  Skills:   ${skillsDir}/*/SKILL.md`);
  console.log(`  Config:   ${configFile}`);
  console.log("");
  note("Get started: opencode → /sync → /spec 'your task'");
  console.log("");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Additive deep merge: copies keys from `source` into `target` without
 * overwriting existing values. When both values are plain objects, recurse.
 * When the target already has a scalar or the source has a scalar, target wins.
 */
export function deepMergeAdditive(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in result)) {
      result[key] = source[key];
    } else if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMergeAdditive(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    }
    // else: target has a value (scalar or mismatched type) — keep it
  }
  return result;
}

/** Safe readdirSync that returns [] if directory doesn't exist. */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Create symlinks so .claude/rules and .claude/skills point to .sentinal/
 * and .opencode/skills points to .sentinal/skills.
 * This gives a single source of truth for project-level rules and skills
 * that works with both Claude Code and OpenCode.
 */
function setupProjectSymlinks(): void {
  console.log("");
  info("Setting up project symlinks (.sentinal/ as canonical source)...");

  const cwd = process.cwd();
  const sentinalRules = join(cwd, ".sentinal", "rules");
  const sentinalSkills = join(cwd, ".sentinal", "skills");

  // Ensure .sentinal directories exist
  mkdirp(sentinalRules);
  mkdirp(sentinalSkills);

  // Migrate .opencode/rules/ content to .sentinal/rules/ if it exists as a real directory
  // (OpenCode reads rules via "instructions" config, not a rules/ symlink)
  const ocRulesDir = join(cwd, ".opencode", "rules");
  if (existsSync(ocRulesDir) && !lstatSync(ocRulesDir).isSymbolicLink()) {
    const entries = readdirSync(ocRulesDir);
    if (entries.length > 0) {
      for (const entry of entries) {
        const src = join(ocRulesDir, entry);
        const dst = join(sentinalRules, entry);
        if (!existsSync(dst)) {
          cpSync(src, dst, { recursive: true });
        }
      }
      info(`    Migrated ${entries.length} rules from .opencode/rules/`);
    }
    rmSync(ocRulesDir, { recursive: true, force: true });
  }

  // Symlink pairs: [link path, target relative to link's parent]
  const links: [string, string][] = [
    [join(cwd, ".claude", "rules"), join("..", ".sentinal", "rules")],
    [join(cwd, ".claude", "skills"), join("..", ".sentinal", "skills")],
    [join(cwd, ".opencode", "skills"), join("..", ".sentinal", "skills")],
  ];

  for (const [linkPath, target] of links) {
    try {
      // Ensure parent directory exists
      const parentDir = join(linkPath, "..");
      mkdirp(parentDir);

      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          // Already a symlink — remove and recreate
          unlinkSync(linkPath);
        } else if (stat.isDirectory()) {
          // Real directory exists — migrate contents to .sentinal/ then remove
          const entries = readdirSync(linkPath);
          if (entries.length > 0) {
            const targetDir = linkPath.includes("rules")
              ? sentinalRules
              : sentinalSkills;
            for (const entry of entries) {
              const src = join(linkPath, entry);
              const dst = join(targetDir, entry);
              if (!existsSync(dst)) {
                cpSync(src, dst, { recursive: true });
              }
            }
            info(
              `    Migrated ${entries.length} items from ${linkPath.replace(cwd + "/", "")}`,
            );
          }
          rmSync(linkPath, { recursive: true, force: true });
        }
      }

      symlinkSync(target, linkPath);
      ok(`    ${linkPath.replace(cwd + "/", "")} → ${target}`);
    } catch (e) {
      info(
        `    ! Symlink skipped: ${linkPath.replace(cwd + "/", "")} (${(e as Error).message})`,
      );
    }
  }
}

/** Set up shell aliases, PATH, and completions after install. */
function setupShellIntegration(): void {
  const shell = detectShell();
  if (!shell) return;
  try {
    const result = applyShellInit(shell);
    ok(`  Shell: ${result.action} (${result.configPath})`);
    // Copy binary to ~/.sentinal/bin/ if dist/sentinal exists
    const distBin = join(resolveSentinalRoot(), "dist", "sentinal");
    const binDir = join(homedir(), ".sentinal", "bin");
    if (existsSync(distBin)) {
      mkdirp(binDir);
      copyFileSync(distBin, join(binDir, "sentinal"));
      chmodSync(join(binDir, "sentinal"), 0o755);
      ok(`  Binary installed to ${binDir}/sentinal`);
    }
  } catch {
    info("  Shell integration skipped (run 'sentinal shell-init' manually)");
  }
}
