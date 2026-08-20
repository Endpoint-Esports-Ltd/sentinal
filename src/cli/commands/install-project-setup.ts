/**
 * Post-install project wiring for `sentinal install` (auto-detect mode).
 *
 * Two concerns, both run once after the target installer(s) finish:
 *   1. `.sentinal/` symlink canonicalisation + migration of legacy
 *      `.claude/rules`, `.claude/skills`, `.opencode/rules|skills` content.
 *   2. Shell integration (aliases, PATH, completions) and copying the built
 *      binary into `~/.sentinal/bin/`.
 *
 * ⛔ Extracted from `install.ts` verbatim — behaviour must stay byte-identical
 * to what shipped before the split.
 */

import {
  existsSync,
  readdirSync,
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
import { info, ok, resolveSentinalRoot, mkdirp } from "../../utils/shell.js";
import { detectShell, applyShellInit } from "./shell-init.js";

/**
 * Create symlinks so .claude/rules and .claude/skills point to .sentinal/
 * and .opencode/skills points to .sentinal/skills.
 * This gives a single source of truth for project-level rules and skills
 * that works with both Claude Code and OpenCode.
 */
export function setupProjectSymlinks(): void {
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
export function setupShellIntegration(): void {
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
