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
 *
 * Split for file length (pure move):
 *   - uninstall-opencode.ts         OpenCode uninstaller body + shell/binary cleanup
 *   - uninstall-opencode-config.ts  OpenCode config cleanup helpers
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  colors,
  info,
  ok,
  err,
  run,
  commandExists,
  resolveXdgConfig,
  removeDirIfExists,
  promptMenu,
} from "../../utils/shell.js";
import {
  uninstallOpenCode as uninstallOpenCodeImpl,
  AGENT_FILES,
  SKILL_DIRS,
  PLUGIN_FILENAMES,
  type UninstallOptions,
} from "./uninstall-opencode.js";

export type { UninstallOptions } from "./uninstall-opencode.js";
export { cleanupOpenCodeConfig } from "./uninstall-opencode-config.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_DIR = join(
  homedir(),
  ".claude",
  "plugins",
  "sentinal-marketplace",
);
const MARKETPLACE_NAME = "sentinal-marketplace";
const PLUGIN_NAME = "sentinal";

// ─── Register command ───────────────────────────────────────────────────────

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall [target]")
    .description(
      "Uninstall Sentinal from an AI assistant (claude, opencode, both)",
    )
    .option(
      "--local",
      "Uninstall OpenCode plugin from current project instead of global",
    )
    .option(
      "--remove-binary",
      "Also remove the sentinal binary, npm package, and shell integration",
    )
    .action(
      async (
        target?: string,
        opts?: { local?: boolean; removeBinary?: boolean },
      ) => {
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
      },
    );
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
    PLUGIN_FILENAMES.some((f) => existsSync(join(opencodePluginsDir, f))) ||
    AGENT_FILES.some((f) =>
      existsSync(join(xdgConfig, "opencode", "agents", f)),
    ) ||
    SKILL_DIRS.some((d) =>
      existsSync(join(xdgConfig, "opencode", "skills", d)),
    );

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
    throw new Error(
      "Claude Code CLI not found. Cannot uninstall Claude Code plugin.",
    );
  }

  let foundSomething = false;

  // ── Uninstall plugin ──

  const pluginList = run(["claude", "plugin", "list"]);
  if (
    pluginList.ok &&
    pluginList.stdout.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)
  ) {
    info("Uninstalling plugin...");
    run([
      "claude",
      "plugin",
      "uninstall",
      `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    ]);
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

/**
 * Delegates to uninstall-opencode.ts. Kept as a real function declaration here
 * (not a re-export) so module-namespace spies on `./uninstall.js` keep working.
 */
export async function uninstallOpenCode(
  opts: UninstallOptions = {},
): Promise<void> {
  return uninstallOpenCodeImpl(opts);
}
