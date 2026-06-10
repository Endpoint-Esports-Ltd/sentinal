#!/usr/bin/env bun
/**
 * Sentinal CLI
 *
 * Unified entry point for the sentinal binary.
 * Routes subcommands to the appropriate module.
 *
 * Usage:
 *   sentinal mcp-server          Start the MCP server (stdio)
 *   sentinal memory <subcommand> Memory CLI (search, list, get, stats, etc.)
 *   sentinal spec <subcommand>   Spec CLI (list, current, sync)
 *   sentinal greet               Display the Sentinal banner
 *   sentinal --version           Print version
 *   sentinal --help              Show help
 */

// Prevent sub-modules' isMainModule guards from firing when imported by the CLI
process.env.__SENTINAL_CLI = "1";

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { greet } from "./commands/greet.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerSpecCommand } from "./commands/spec.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerSessionsCommand } from "./commands/sessions.js";
import { registerCheckContextCommand } from "./commands/check-context.js";
import { registerRegisterPlanCommand } from "./commands/register-plan.js";
import { registerWorktreeCommand } from "./commands/worktree.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerShellInitCommand } from "./commands/shell-init.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerSidecarCommand } from "./commands/sidecar.js";
import { registerStatuslineCommand } from "./commands/statusline.js";
import { registerUsageCommand } from "./commands/usage.js";

// ─── Version ─────────────────────────────────────────────────────────────────

// Injected at compile time by `bun build --define`. Falls back to package.json at runtime.
declare const __SENTINAL_VERSION__: string | undefined;

export function getVersion(): string {
  // Prefer compile-time constant (set by build:cli --define)
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }

  // Fallback: read from package.json (works when running from source)
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const version = getVersion();

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command()
  .name("sentinal")
  .description("Quality enforcement for TypeScript, Angular, and NestJS")
  .version(version, "-v, --version")
  .option("--skip-update-check", "Skip automatic update check");

// ─── mcp-server ──────────────────────────────────────────────────────────────

program
  .command("mcp-server")
  .description("Start the Sentinal MCP server (stdio transport)")
  .action(async () => {
    const { main } = await import("../mcp/server.js");
    await main();
  });

// ─── memory ──────────────────────────────────────────────────────────────────

program
  .command("memory")
  .description("Memory CLI — search, list, get, stats, prune, repair, export")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    const { runCli } = await import("../memory/cli.js");
    // Pass all args after "memory" to the existing CLI dispatcher
    const memIdx = process.argv.indexOf("memory");
    const args = memIdx >= 0 ? process.argv.slice(memIdx + 1) : [];
    const output = await runCli(args);
    console.log(output);
  });

// ─── greet ───────────────────────────────────────────────────────────────────

program
  .command("greet")
  .description("Display the Sentinal banner")
  .action(() => {
    greet(version);
  });

// ─── spec ────────────────────────────────────────────────────────────────────

registerSpecCommand(program);

// ─── config ─────────────────────────────────────────────────────────────────

registerConfigCommand(program);

// ─── sessions ───────────────────────────────────────────────────────────────

registerSessionsCommand(program);

// ─── check-context ──────────────────────────────────────────────────────────

registerCheckContextCommand(program);

// ─── register-plan ──────────────────────────────────────────────────────────

registerRegisterPlanCommand(program);

// ─── worktree ───────────────────────────────────────────────────────────────

registerWorktreeCommand(program);

// ─── serve ──────────────────────────────────────────────────────────────────

registerServeCommand(program);

// ─── install / uninstall ─────────────────────────────────────────────────────

registerInstallCommand(program);
registerUninstallCommand(program);

// ─── update / completion / shell-init ────────────────────────────────────────

registerUpdateCommand(program);
registerCompletionCommand(program);
registerShellInitCommand(program);

// ─── hook ───────────────────────────────────────────────────────────────────

registerHookCommand(program);

// ─── sidecar ────────────────────────────────────────────────────────────────

registerSidecarCommand(program);

// ─── statusline ────────────────────────────────────────────────────────────

registerStatuslineCommand(program);

// ─── usage ─────────────────────────────────────────────────────────────────

registerUsageCommand(program);

// ─── Update check (non-blocking) ────────────────────────────────────────────

async function maybeCheckForUpdate(): Promise<void> {
  // Skip for commands that shouldn't trigger update checks
  const skipCommands = [
    "update",
    "completion",
    "mcp-server",
    "hook",
    "sidecar",
    // memory: `memory setup` must call Database.setCustomSQLite() BEFORE any
    // Database opens — the update check's MemoryStore would poison it.
    "memory",
    "statusline",
    "help",
    "--help",
    "-h",
  ];
  const firstArg = process.argv[2];
  if (!firstArg || skipCommands.includes(firstArg)) return;

  // Skip if --skip-update-check is present
  if (process.argv.includes("--skip-update-check")) return;

  try {
    const { checkForUpdate } = await import("./commands/update.js");
    const result = await checkForUpdate(version);
    if (result.updateAvailable && result.latestVersion) {
      console.error(
        `\x1b[33mUpdate available: v${version} → v${result.latestVersion}. Run 'sentinal update' to upgrade.\x1b[0m`,
      );
    }
  } catch {
    // Silently ignore update check failures — never block CLI usage
  }
}

// ─── Parse ───────────────────────────────────────────────────────────────────

// Fire update check in background (non-blocking), then parse commands
maybeCheckForUpdate().finally(() => {});
program.parse();
