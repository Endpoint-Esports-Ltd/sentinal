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
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
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
  isGlobalInstall,
  copyDirRecursive,
  mkdirp,
  promptMenu,
  stripJsoncComments,
} from "../../utils/shell.js";
import { greet } from "./greet.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_DIR = join(homedir(), ".claude", "plugins", "sentinal-marketplace");
const MARKETPLACE_NAME = "sentinal-marketplace";
const PLUGIN_NAME = "sentinal";

const MCP_SERVERS_OPENCODE = {
  context7: {
    type: "local" as const,
    command: ["npx", "-y", "@upstash/context7-mcp"],
  },
  "web-search": {
    type: "local" as const,
    command: ["npx", "-y", "open-websearch"],
    environment: {
      MODE: "stdio",
      DEFAULT_SEARCH_ENGINE: "duckduckgo",
      ALLOWED_SEARCH_ENGINES: "duckduckgo,bing,exa",
    },
  },
  "grep-mcp": {
    type: "remote" as const,
    url: "https://mcp.grep.app",
  },
  "web-fetch": {
    type: "local" as const,
    command: ["npx", "-y", "fetcher-mcp"],
  },
  "sentinal-memory": {
    type: "local" as const,
    command: ["sentinal", "mcp-server"],
  },
};

const AGENTS_MD_GLOBAL = `# Sentinal Global Standards

This file is automatically loaded by OpenCode for all projects.

## Quality Enforcement

Sentinal automatically enforces quality standards on every file edit:
- **File length:** Warn at 400 lines, block at 600 lines (test files exempt)
- **TDD:** Check for companion test files on implementation files
- **NestJS:** Validate decorators on controllers, DTOs, and entities
- **TypeScript:** Run tsc --noEmit for type checking

Note: Prettier and ESLint are handled automatically by OpenCode's built-in formatter system.

## Commands

- \`/spec <task>\` - Start a spec-driven plan-implement-verify workflow
- \`/spec <plan.md>\` - Resume an existing plan
- \`/sync\` - Analyze codebase and generate project-specific rules
- \`/learn\` - Extract reusable knowledge from this session

## Rule Files

The following rule files are loaded based on project context. Read them on a need-to-know basis:

- \`standards-typescript.md\` - TypeScript best practices
- \`standards-angular.md\` - Angular 17+ patterns (signals, control flow, standalone)
- \`standards-nestjs.md\` - NestJS patterns (DTOs, guards, Swagger)
- \`standards-frontend.md\` - Tailwind CSS, accessibility, responsive design
- \`standards-backend.md\` - REST API, security, database patterns
`;

const AGENTS_MD_LOCAL_TEMPLATE = `# Project Name

TODO: Add project description.

## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See \`.opencode/rules/\` for coding standards.

## Commands

- \`/spec <task>\` - Start a spec-driven plan-implement-verify workflow
- \`/sync\` - Analyze codebase and generate project-specific rules
`;

const AGENTS_MD_APPEND = `
## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See \`.opencode/rules/\` for coding standards.
`;

// ─── Register command ───────────────────────────────────────────────────────

export function registerInstallCommand(program: Command): void {
  program
    .command("install [target]")
    .description("Install Sentinal for an AI assistant (claude, opencode, both)")
    .option("--local", "Install OpenCode plugin to current project instead of global")
    .action(async (target?: string, opts?: { local?: boolean }) => {
      try {
        await installDispatcher(target, opts);
      } catch (e) {
        err(`Install failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function installDispatcher(
  target?: string,
  opts?: { local?: boolean },
): Promise<void> {
  const local = opts?.local ?? false;

  // Explicit target
  if (target) {
    switch (target.toLowerCase()) {
      case "claude":
      case "claude-code":
        await installClaudeCode();
        return;
      case "opencode":
        await installOpenCode(local);
        return;
      case "both":
        await installClaudeCode();
        console.log("");
        await installOpenCode(local);
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
    await installOpenCode(local);
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
        await installOpenCode(local);
        break;
      case 3:
        await installClaudeCode();
        console.log("");
        await installOpenCode(local);
        break;
      default:
        console.log("Installation cancelled.");
        return;
    }
  }

  console.log("");
  ok("Installation complete!");
}

// ─── Claude Code installer ──────────────────────────────────────────────────

async function installClaudeCode(): Promise<void> {
  console.log("Sentinal for Claude Code — TypeScript/Angular/NestJS Quality Enforcement");
  console.log("=========================================================================");
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

  if (!commandExists("bun")) {
    err("ERROR: Bun is required. Install from https://bun.sh");
    process.exit(1);
  }
  const bunVersion = run(["bun", "--version"]).stdout;
  ok(`[OK] Bun v${bunVersion}`);

  if (!commandExists("claude")) {
    err("ERROR: Claude Code CLI is required.");
    console.log("  Install: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
  ok("[OK] Claude Code CLI");

  // ── Build (only if running from source, not from global install) ──

  const sentinalRoot = resolveSentinalRoot();

  if (!isGlobalInstall()) {
    console.log("");
    info("Installing dependencies...");
    const installResult = run(["bun", "install"], { cwd: sentinalRoot });
    if (!installResult.ok) {
      err(`Failed to install dependencies: ${installResult.stderr}`);
      process.exit(1);
    }

    console.log("");
    info("Building hooks...");
    const buildResult = run(["bun", "run", "build:claude"], { cwd: sentinalRoot });
    if (!buildResult.ok) {
      err(`Failed to build: ${buildResult.stderr}`);
      process.exit(1);
    }
  }

  // ── Remove previous installation ──

  const pluginList = run(["claude", "plugin", "list"]);
  if (pluginList.ok && pluginList.stdout.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) {
    console.log("");
    info("Removing previous Sentinal installation...");
    run(["claude", "plugin", "uninstall", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
  }

  const marketplaceList = run(["claude", "plugin", "marketplace", "list"]);
  if (marketplaceList.ok && marketplaceList.stdout.includes(MARKETPLACE_NAME)) {
    run(["claude", "plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  }

  // Clean previous marketplace directory
  if (existsSync(MARKETPLACE_DIR)) {
    const { rmSync } = await import("node:fs");
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
        description: "Quality enforcement for TypeScript, Angular, and NestJS projects",
      },
    ],
  };

  writeFileSync(
    join(MARKETPLACE_DIR, ".claude-plugin", "marketplace.json"),
    JSON.stringify(marketplaceManifest, null, 2) + "\n",
  );

  // Copy the entire claude-code target into the marketplace plugin dir
  const assetsDir = resolveAssetsDir();
  const claudeTarget = join(assetsDir, "claude-code");

  copyDirRecursive(claudeTarget, pluginDir, {
    exclude: ["install.sh", "uninstall.sh", "tsconfig.json"],
  });

  ok(`[OK] Marketplace created at ${MARKETPLACE_DIR}`);

  // ── Register & install ──

  console.log("");
  info("Registering marketplace...");
  const addResult = run(["claude", "plugin", "marketplace", "add", MARKETPLACE_DIR]);
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

  // ── Done ──

  console.log("");
  console.log("=========================================================================");
  ok("  Sentinal for Claude Code installed successfully!");
  console.log("=========================================================================");
  console.log("");
  console.log(`  Plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  console.log("");
  console.log("  Available commands:");
  console.log("    /sentinal:spec              Spec-driven development workflow");
  console.log("    /sentinal:spec-plan         Feature planning phase");
  console.log("    /sentinal:spec-bugfix-plan  Bugfix planning phase");
  console.log("    /sentinal:spec-implement    TDD implementation phase");
  console.log("    /sentinal:spec-verify       Feature verification");
  console.log("    /sentinal:spec-bugfix-verify Bugfix verification");
  console.log("    /sentinal:sync              Sync project rules");
  console.log("    /sentinal:learn             Extract session knowledge");
  console.log("");
  console.log("  Restart Claude Code to activate the plugin.");
  console.log("");
}

// ─── OpenCode installer ─────────────────────────────────────────────────────

async function installOpenCode(local: boolean): Promise<void> {
  greet();
  note("  for OpenCode");
  console.log("");

  // ── Prerequisites ──

  info("Checking prerequisites...");

  if (!commandExists("opencode")) {
    err("x OpenCode not found");
    console.log("");
    console.log("Install OpenCode from https://opencode.ai:");
    console.log("  curl -fsSL https://opencode.ai/install | bash");
    console.log("");
    process.exit(1);
  }
  ok("  OpenCode found");

  if (!commandExists("bun")) {
    err("x Bun not found");
    console.log("  Install from https://bun.sh");
    process.exit(1);
  }
  ok("  Bun found");

  if (!commandExists("node")) {
    err("x Node.js not found");
    console.log("  Install Node.js 18+ from https://nodejs.org");
    process.exit(1);
  }
  ok("  Node.js found");

  // NOTE: No jq check — we do JSON natively in TypeScript!

  console.log("");

  // ── Determine target directories ──

  const xdgConfig = resolveXdgConfig();
  const globalConfig = join(xdgConfig, "opencode");

  let targetDir: string;
  let pluginsDir: string;
  let commandsDir: string;
  let rulesDir: string;
  let toolsDir: string;

  if (local) {
    targetDir = join(process.cwd(), ".opencode");
    pluginsDir = join(targetDir, "plugins");
    commandsDir = join(targetDir, "commands");
    rulesDir = join(targetDir, "rules");
    toolsDir = join(targetDir, "tools");
    note(`Installing to current project: ${targetDir}`);
  } else {
    targetDir = globalConfig;
    pluginsDir = join(globalConfig, "plugins");
    commandsDir = join(globalConfig, "commands");
    rulesDir = join(globalConfig, "rules");
    toolsDir = join(globalConfig, "tools");
    note(`Installing globally: ${targetDir}`);
  }

  console.log("");

  // ── Create directories ──

  info("Creating directories...");
  mkdirp(pluginsDir);
  mkdirp(commandsDir);
  mkdirp(rulesDir);
  mkdirp(toolsDir);
  ok("  Directories created");

  // ── Install @endpoint/sentinal globally ──

  info("Installing @endpoint/sentinal globally...");

  // Check scoped registry
  const npmrcPath = join(homedir(), ".npmrc");
  let hasRegistry = false;
  if (existsSync(npmrcPath)) {
    const npmrc = readFileSync(npmrcPath, "utf-8");
    hasRegistry = npmrc.includes("@endpoint:registry");
  }
  if (!hasRegistry) {
    err("x Scoped registry not configured for @endpoint packages");
    console.log("");
    console.log("Add the following to ~/.npmrc:");
    console.log("  @endpoint:registry=https://npm.cloud.endpoint.gg/");
    console.log("");
    process.exit(1);
  }

  if (commandExists("sentinal")) {
    ok("  @endpoint/sentinal already installed globally");
  } else {
    const installResult = run(["bun", "add", "-g", "@endpoint/sentinal"]);
    if (!installResult.ok) {
      err(`Failed to install @endpoint/sentinal: ${installResult.stderr}`);
      process.exit(1);
    }
    ok("  @endpoint/sentinal installed globally");
  }

  // Verify sentinal binary is available
  if (!commandExists("sentinal")) {
    info("  ! sentinal binary not found in PATH");
    console.log('  You may need to add ~/.bun/bin to your PATH:');
    console.log('    export PATH="$HOME/.bun/bin:$PATH"');
    console.log("");
  }

  // ── Copy assets ──

  const assetsDir = resolveAssetsDir();
  const opencodeTarget = join(assetsDir, "opencode");

  // Plugin
  info("Installing Sentinal plugin...");
  copyFileSync(
    join(opencodeTarget, "plugins", "sentinal.ts"),
    join(pluginsDir, "sentinal.ts"),
  );
  ok(`  Plugin installed: ${pluginsDir}/sentinal.ts`);

  // Commands
  info("Installing commands...");
  const cmdFiles = readdirSyncSafe(join(opencodeTarget, "commands")).filter((f) =>
    f.endsWith(".md"),
  );
  for (const file of cmdFiles) {
    copyFileSync(join(opencodeTarget, "commands", file), join(commandsDir, file));
    ok(`    ${file}`);
  }

  // Rules
  info("Installing rules...");
  const ruleFiles = readdirSyncSafe(join(opencodeTarget, "rules")).filter((f) =>
    f.endsWith(".md"),
  );
  for (const file of ruleFiles) {
    copyFileSync(join(opencodeTarget, "rules", file), join(rulesDir, file));
    ok(`    ${file}`);
  }

  // Tools
  info("Installing custom tools...");
  const toolSrc = join(opencodeTarget, "tools", "sentinal-check.ts");
  if (existsSync(toolSrc)) {
    copyFileSync(toolSrc, join(toolsDir, "sentinal-check.ts"));
    ok("    sentinal-check.ts");
  }

  // ── AGENTS.md ──

  info("Creating AGENTS.md...");
  if (!local) {
    // Global: write complete file
    writeFileSync(join(targetDir, "AGENTS.md"), AGENTS_MD_GLOBAL);
    ok("  Global AGENTS.md created");
  } else {
    // Local: append or create
    const agentsPath = join(process.cwd(), "AGENTS.md");
    if (existsSync(agentsPath)) {
      const existing = readFileSync(agentsPath, "utf-8");
      writeFileSync(agentsPath, existing + AGENTS_MD_APPEND);
      ok("  Updated existing AGENTS.md");
    } else {
      writeFileSync(agentsPath, AGENTS_MD_LOCAL_TEMPLATE);
      ok("  Created AGENTS.md");
    }
  }

  // ── opencode.json config ──

  info("Configuring OpenCode...");

  const pluginPath = local
    ? ".opencode/plugins/sentinal.ts"
    : join(pluginsDir, "sentinal.ts");

  const configDir = local ? process.cwd() : targetDir;

  // Detect existing config
  let configFile = join(configDir, "opencode.json");
  let existingConfig: string | null = null;

  if (existsSync(configFile)) {
    existingConfig = configFile;
  } else if (existsSync(join(configDir, "opencode.jsonc"))) {
    existingConfig = join(configDir, "opencode.jsonc");
    configFile = existingConfig;
  }

  if (existingConfig) {
    info(`  Found existing config: ${existingConfig}`);

    let content = readFileSync(existingConfig, "utf-8");

    // Strip comments for .jsonc files
    if (existingConfig.endsWith(".jsonc")) {
      content = stripJsoncComments(content);
    }

    // Parse and validate
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(content);
    } catch {
      err(`x Existing config has invalid JSON syntax`);
      console.log(`  Please fix: ${existingConfig}`);
      process.exit(1);
    }

    // Add plugin path if not already present
    const plugins = (config.plugin as string[]) ?? [];
    if (plugins.includes(pluginPath)) {
      ok("    Sentinal plugin already in config");
    } else {
      info("    Adding Sentinal plugin...");
      config.plugin = [...plugins, pluginPath];
      ok("    Plugin added");
    }

    // Merge MCP servers (existing keys win — matches jq `$new * $existing` semantics)
    info("    Merging MCP server configurations...");
    const existingMcp = (config.mcp as Record<string, unknown>) ?? {};
    config.mcp = { ...MCP_SERVERS_OPENCODE, ...existingMcp };
    ok("    MCP servers merged");

    // Write back
    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    ok("  OpenCode configuration updated");
  } else {
    info("  No existing config found, creating new one...");

    const config = {
      $schema: "https://opencode.ai/config.json",
      plugin: [pluginPath],
      mcp: MCP_SERVERS_OPENCODE,
      lsp: {
        typescript: {
          command: ["typescript-language-server", "--stdio"],
        },
      },
    };

    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    ok(`  OpenCode configuration created: ${configFile}`);
  }

  // ── Success ──

  console.log("");
  console.log(`${colors.green}${"=".repeat(68)}${colors.nc}`);
  ok("  Sentinal for OpenCode installed successfully!");
  console.log(`${colors.green}${"=".repeat(68)}${colors.nc}`);
  console.log("");
  note("What was installed:");
  console.log(`  * Package:  @endpoint/sentinal`);
  console.log(`  * Plugin:   ${pluginsDir}/sentinal.ts`);
  console.log(`  * Commands: ${commandsDir}/*.md`);
  console.log(`  * Rules:    ${rulesDir}/*.md`);
  console.log(`  * Tools:    ${toolsDir}/sentinal-check.ts`);
  console.log(`  * Config:   ${configFile}`);
  console.log("");
  note("Get started:");
  console.log("  1. Navigate to a project:  cd /path/to/project");
  console.log("  2. Run OpenCode:           opencode");
  console.log("  3. Initialize project:     /init");
  console.log("  4. Sync project rules:     /sync");
  console.log("  5. Start a workflow:       /spec 'add user authentication'");
  console.log("");
  note("Features:");
  console.log("  * Automatic quality checks on every file edit");
  console.log("  * TypeScript, Angular 17+, and NestJS standards");
  console.log("  * Spec-driven development with /spec workflow");
  console.log("  * File length enforcement (400 warn, 600 block)");
  console.log("  * TDD enforcement with companion test file checks");
  console.log("");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safe readdirSync that returns [] if directory doesn't exist. */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
