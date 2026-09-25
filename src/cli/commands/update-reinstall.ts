/**
 * Update — plugin reinstall after a binary update
 *
 * Split out of update.ts; re-exported from there. Dependencies are imported
 * from their own modules (uninstall.js, install.js, sidecar-staleness.js) so
 * `spyOn(<thoseModules>, …)` in update.test.ts still intercepts them.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  detectInstalledTargets,
  uninstallClaudeCode,
  uninstallOpenCode,
} from "./uninstall.js";
import { installClaudeCode, installOpenCode } from "./install.js";
import { ensureSentinalGitignore } from "../../memory/shared.js";
import { warnIfSidecarStale } from "./sidecar-staleness.js";
import { BIN_PATH } from "./update-download.js";

/**
 * Detect which assistants have Sentinal installed, uninstall old plugin data
 * (preserving binary/shell/npm), then reinstall for the same targets.
 *
 * Called after a successful binary download. Failures are non-fatal —
 * the binary is already updated; user can manually `sentinal install`.
 *
 * ⛔ R9a: the `.sentinal/.gitignore` upgrade runs FIRST, before the
 * no-assistant early return. It is a project-file migration, not a plugin
 * concern — skipping it when no assistant happens to be detected would leave
 * `.sentinal/runtime.json` ignored on exactly the installs that most need the
 * upgrade. No-op unless `.sentinal/` exists in a git work tree; never touches
 * a user-customised file.
 */
export async function reinstallPlugins(): Promise<void> {
  ensureSentinalGitignore(process.cwd());

  // Detect BEFORE uninstalling (Pre-Mortem #2)
  const targets = detectInstalledTargets();

  if (!targets.claude && !targets.opencode) {
    console.log(
      "\nNo assistant installations detected — skipping plugin reinstall.",
    );
    return;
  }

  const names: string[] = [];
  if (targets.claude) names.push("Claude Code");
  if (targets.opencode) names.push("OpenCode");
  console.log(`\nReinstalling plugins for: ${names.join(", ")}...`);
  console.log("");

  // Claude Code: uninstall → install
  if (targets.claude) {
    try {
      await uninstallClaudeCode();
      console.log("");
      await installClaudeCode();
    } catch (e) {
      console.error(
        `Warning: Claude Code reinstall failed: ${(e as Error).message}`,
      );
      console.error("  Run 'sentinal install claude' manually to fix.");
    }
    console.log("");
  }

  // OpenCode: uninstall (preserve binary) → install (bundled mode)
  if (targets.opencode) {
    try {
      await uninstallOpenCode({ preserveBinary: true });
      console.log("");
      await installOpenCode(false, true);
    } catch (e) {
      console.error(
        `Warning: OpenCode reinstall failed: ${(e as Error).message}`,
      );
      console.error("  Run 'sentinal install opencode' manually to fix.");
    }
  }
}

// ─── Post-update reinstall (via the NEW binary) ─────────────────────────────

export interface PostUpdateReinstallOptions {
  /** Path to the freshly installed binary (default: ~/.sentinal/bin/sentinal). */
  binPath?: string;
  /**
   * Spawns the reinstall subprocess; returns its exit code. Throws on spawn
   * failure. Injectable for tests; default uses child_process.spawnSync with
   * stdio: "inherit".
   */
  spawner?: (cmd: string[]) => number;
  /** Version just installed — the in-process fallback's stale-sidecar check. */
  installedVersion?: string | null;
}

/** Default spawner: run the command synchronously, inheriting stdio. */
function spawnReinstall(cmd: string[]): number {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Run the post-update plugin reinstall via the NEWLY installed binary.
 *
 * Why a subprocess: this process's embedded assets (src/cli/embedded-assets.ts)
 * were baked in at ITS build time. After downloadAndInstall() swaps the binary
 * on disk, calling reinstallPlugins() in-process would deploy the OLD
 * version's plugin/hooks/commands (observed in the v1.28.0 → v1.29.0 upgrade).
 * Spawning `<new-binary> update --reinstall-plugins` guarantees the assets
 * come from the new version.
 *
 * Falls back to the in-process reinstall (previous behavior) if the binary is
 * missing or the subprocess fails — e.g. when running from source.
 */
export async function runPostUpdateReinstall(
  opts: PostUpdateReinstallOptions = {},
): Promise<void> {
  const binPath = opts.binPath ?? BIN_PATH;
  const spawner = opts.spawner ?? spawnReinstall;

  if (existsSync(binPath)) {
    try {
      const exitCode = spawner([binPath, "update", "--reinstall-plugins"]);
      if (exitCode === 0) return;
      console.error(
        `Warning: reinstall via new binary exited with code ${exitCode} — ` +
          "falling back to in-process reinstall (assets may be stale; " +
          "run 'sentinal install' to be sure).",
      );
    } catch (e) {
      console.error(
        `Warning: failed to spawn new binary for reinstall (${(e as Error).message}) — ` +
          "falling back to in-process reinstall (assets may be stale; " +
          "run 'sentinal install' to be sure).",
      );
    }
  }

  await reinstallPlugins();
  if (opts.installedVersion) await warnIfSidecarStale(opts.installedVersion);
}
