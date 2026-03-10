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

// ─── Version ─────────────────────────────────────────────────────────────────

// Injected at compile time by `bun build --define`. Falls back to package.json at runtime.
declare const __SENTINAL_VERSION__: string | undefined;

function getVersion(): string {
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
  .version(version, "-v, --version");

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

// ─── Parse ───────────────────────────────────────────────────────────────────

program.parse();
