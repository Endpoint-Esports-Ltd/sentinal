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
 *
 * ─── Module layout ─────────────────────────────────────────────────────────
 * This file used to be ~1050 lines — nearly double Sentinal's own 600-line
 * block threshold, on the code path that installs Sentinal onto users'
 * machines. It is now the command surface only; the work lives in cohesive
 * siblings:
 *
 *   install-prereqs.ts         optional-dependency probes (soft, never exit)
 *   install-constants.ts       marketplace names, MCP blocks, AGENTS.md text
 *   install-shared.ts          binary-mode detection + config merge helpers
 *   install-claude.ts          the Claude Code installer
 *   install-opencode.ts        the OpenCode installer
 *   install-opencode-config.ts opencode.json creation / additive merge
 *   install-project-setup.ts   .sentinal/ symlinks + shell integration
 *
 * The re-exports below exist because `install.test.ts` and `update.ts` import
 * these names from this module; the split must not change their import paths.
 */

import type { Command } from "commander";
import {
  colors,
  info,
  ok,
  err,
  commandExists,
  promptMenu,
} from "../../utils/shell.js";
import { greet } from "./greet.js";
import { runAutoSetup } from "./auto-setup.js";
import { ensureSentinalGitignore } from "../../memory/shared.js";
import { installClaudeCode } from "./install-claude.js";
import { installOpenCode } from "./install-opencode.js";
import {
  setupProjectSymlinks,
  setupShellIntegration,
} from "./install-project-setup.js";

// ─── Re-exports (import paths that predate the split) ──────────────────────

export { installClaudeCode } from "./install-claude.js";
export { installOpenCode } from "./install-opencode.js";
export { checkPlaywrightCli } from "./install-prereqs.js";
export { buildPluginList, deepMergeAdditive } from "./install-shared.js";

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
          await runInstallAction(target, opts);
        } catch (e) {
          err(`Install failed: ${(e as Error).message}`);
          process.exit(1);
        }
      },
    );
}

// ─── Install action (dispatch + post-install auto-setup) ───────────────────

export interface InstallActionDeps {
  /** Injectable dispatcher for tests. Default: installDispatcher. */
  dispatcher?: (
    target?: string,
    opts?: { local?: boolean; bundled?: boolean },
  ) => Promise<void>;
  /** Injectable auto-setup for tests. Default: runAutoSetup. */
  autoSetup?: (label: string) => Promise<void>;
}

/**
 * The `install` command action: dispatch to the target installer(s), then
 * provision semantic search exactly once per user-facing install. The setup
 * call lives HERE (not inside installClaudeCode/installOpenCode) so that
 * `update --reinstall-plugins` — which calls both installers — doesn't
 * trigger setup multiple times. runAutoSetup() is non-fatal by design.
 *
 * ⛔ R9a: `ensureSentinalGitignore` lives HERE, not inside a target installer
 * or inside `setupProjectSymlinks`. `setupProjectSymlinks` runs only in
 * auto-detect mode — an explicit `sentinal install claude|opencode|both`
 * returns from the dispatcher before reaching it — so the `.gitignore` upgrade
 * that makes `.sentinal/runtime.json` committable would miss every explicit
 * target. It is a no-op unless `.sentinal/` exists inside a git work tree, and
 * it never touches a user-customised file.
 */
export async function runInstallAction(
  target?: string,
  opts?: { local?: boolean; bundled?: boolean },
  deps: InstallActionDeps = {},
): Promise<void> {
  await (deps.dispatcher ?? installDispatcher)(target, opts);
  ensureSentinalGitignore(process.cwd());
  await (deps.autoSetup ?? runAutoSetup)("install");
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
