/**
 * Sentinal Uninstall — OpenCode uninstaller
 *
 * Removes the Sentinal plugin, commands, rules, agents, skills, config
 * entries, shell integration, and binary for OpenCode installs. Extracted
 * from uninstall.ts as a pure move (file-length split); uninstall.ts keeps
 * the public `uninstallOpenCode` entry point and delegates here.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  colors,
  info,
  ok,
  note,
  run,
  commandExists,
  resolveXdgConfig,
  removeFileIfExists,
  removeDirIfExists,
  removeDirIfEmpty,
} from "../../utils/shell.js";
import { detectShell, getShellConfigPath, removeBlock } from "./shell-init.js";
import { cleanupOpenCodeConfigFile } from "./uninstall-opencode-config.js";

// ─── Constants ──────────────────────────────────────────────────────────────

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

/** Agent files installed by Sentinal. */
export const AGENT_FILES = ["plan-reviewer.md", "spec-reviewer.md"];

/** Skill directory names installed by Sentinal. */
export const SKILL_DIRS = [
  "spec-plan",
  "spec-implement",
  "spec-verify",
  "spec-bugfix-plan",
  "spec-bugfix-verify",
];

/** All possible plugin filenames (deployed via different install paths). */
export const PLUGIN_FILENAMES = ["sentinal.mjs", "sentinal.ts", "sentinal.js"];

// ─── Options ────────────────────────────────────────────────────────────────

export interface UninstallOptions {
  /** Uninstall OpenCode from current project instead of global. */
  local?: boolean;
  /** When true, preserve binary, npm package, shell integration, and AGENTS.md. */
  preserveBinary?: boolean;
}

// ─── OpenCode uninstaller ───────────────────────────────────────────────────

export async function uninstallOpenCode(
  opts: UninstallOptions = {},
): Promise<void> {
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
  // Value-matching cleanup, .bak, and skip-on-unparseable all live in
  // uninstall-opencode-config.ts (M7b/M7c) — it prints its own output.

  info("Cleaning opencode config...");
  cleanupOpenCodeConfigFile(local ? process.cwd() : targetDir);

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
