/**
 * Shell Init Command
 *
 * `sentinal shell-init` — Set up shell aliases, PATH, and completions.
 *
 * Detects shell from $SHELL and writes a managed block to the appropriate config file:
 *   - Bash: ~/.bashrc
 *   - Zsh: ~/.zshrc
 *   - Fish: ~/.config/fish/config.fish
 *
 * The block is idempotent — wrapped in markers and replaced on re-run.
 */

import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Constants ───────────────────────────────────────────────────────────────

const MARKER_START = "# --- sentinal start ---";
const MARKER_END = "# --- sentinal end ---";
const BIN_DIR = join(homedir(), ".sentinal", "bin");

export type ShellType = "bash" | "zsh" | "fish";

// ─── Shell detection ─────────────────────────────────────────────────────────

/** Detect shell type from $SHELL env var. */
export function detectShell(): ShellType | null {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("fish")) return "fish";
  return null;
}

/** Get the config file path for a given shell type. */
export function getShellConfigPath(shell: ShellType): string {
  switch (shell) {
    case "bash":
      return join(homedir(), ".bashrc");
    case "zsh":
      return join(homedir(), ".zshrc");
    case "fish":
      return join(homedir(), ".config", "fish", "config.fish");
  }
}

// ─── Block generation ────────────────────────────────────────────────────────

/** Generate the shell block for bash/zsh. */
function generatePosixBlock(): string {
  return [
    MARKER_START,
    `export PATH="${BIN_DIR}:$PATH"`,
    `alias snt="sentinal"`,
    `eval "$(sentinal completion $(basename "$SHELL"))"`,
    MARKER_END,
  ].join("\n");
}

/** Generate the shell block for fish. */
function generateFishBlock(): string {
  return [
    MARKER_START,
    `fish_add_path -g ${BIN_DIR}`,
    `alias snt sentinal`,
    `sentinal completion fish | source`,
    MARKER_END,
  ].join("\n");
}

/** Generate the appropriate block for a shell type. */
export function generateShellBlock(shell: ShellType): string {
  return shell === "fish" ? generateFishBlock() : generatePosixBlock();
}

// ─── File manipulation ───────────────────────────────────────────────────────

/**
 * Insert or replace the sentinal block in file content.
 * Returns the new file content.
 */
export function upsertBlock(existingContent: string, block: string): string {
  const startIdx = existingContent.indexOf(MARKER_START);
  const endIdx = existingContent.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + MARKER_END.length);
    return before + block + after;
  }

  // Append — ensure newline separation
  const separator = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n\n" : "\n";
  return existingContent + separator + block + "\n";
}

/**
 * Remove the sentinal block from file content.
 * Returns the new file content, or null if no block found.
 */
export function removeBlock(existingContent: string): string | null {
  const startIdx = existingContent.indexOf(MARKER_START);
  const endIdx = existingContent.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) return null;

  const before = existingContent.slice(0, startIdx);
  const after = existingContent.slice(endIdx + MARKER_END.length);

  // Clean up extra blank lines
  return (before + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ─── Main logic ──────────────────────────────────────────────────────────────

export interface ShellInitResult {
  shell: ShellType;
  configPath: string;
  action: "created" | "updated" | "unchanged";
  block: string;
}

/** Apply shell init to a config file. Returns what was done. */
export function applyShellInit(shell: ShellType): ShellInitResult {
  const configPath = getShellConfigPath(shell);
  const block = generateShellBlock(shell);

  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";

  // Check if already up-to-date
  if (existing.includes(block)) {
    return { shell, configPath, action: "unchanged", block };
  }

  const newContent = upsertBlock(existing, block);

  // Ensure parent directory exists (for fish)
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, newContent);

  const action = existing.includes(MARKER_START) ? "updated" : "created";
  return { shell, configPath, action, block };
}

// ─── Register command ────────────────────────────────────────────────────────

export function registerShellInitCommand(program: Command): void {
  program
    .command("shell-init")
    .description("Set up shell aliases, PATH, and tab completions")
    .option("--dry-run", "Print what would be written without modifying files")
    .option("--shell <shell>", "Override shell detection (bash, zsh, fish)")
    .option("--remove", "Remove sentinal block from shell config")
    .action((opts: { dryRun?: boolean; shell?: string; remove?: boolean }) => {
      const shell = (opts.shell as ShellType) ?? detectShell();

      if (!shell) {
        console.error(
          "Could not detect shell from $SHELL. Use --shell bash|zsh|fish to specify.",
        );
        process.exit(1);
      }

      if (!["bash", "zsh", "fish"].includes(shell)) {
        console.error(`Unsupported shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }

      const configPath = getShellConfigPath(shell);

      if (opts.remove) {
        const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
        const result = removeBlock(existing);
        if (!result) {
          console.log(`No sentinal block found in ${configPath}`);
          return;
        }
        if (opts.dryRun) {
          console.log(`Would remove sentinal block from ${configPath}`);
          return;
        }
        writeFileSync(configPath, result);
        console.log(`Removed sentinal block from ${configPath}`);
        return;
      }

      if (opts.dryRun) {
        const block = generateShellBlock(shell);
        console.log(`Shell: ${shell}`);
        console.log(`Config: ${configPath}`);
        console.log(`\nBlock that would be written:\n`);
        console.log(block);
        return;
      }

      const result = applyShellInit(shell);

      switch (result.action) {
        case "created":
          console.log(`Added sentinal block to ${result.configPath}`);
          console.log(`Restart your shell or run: source ${result.configPath}`);
          break;
        case "updated":
          console.log(`Updated sentinal block in ${result.configPath}`);
          console.log(`Restart your shell or run: source ${result.configPath}`);
          break;
        case "unchanged":
          console.log(`Shell config already up to date: ${result.configPath}`);
          break;
      }
    });
}
