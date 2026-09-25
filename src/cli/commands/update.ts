/**
 * Update Command
 *
 * `sentinal update` — Check for and install updates from GitHub Releases.
 * `sentinal update --check` — Check only, don't install.
 *
 * Downloads platform-specific pre-built binary from GitHub Release assets.
 * Caches update check timestamp in SQLite settings (24h TTL).
 *
 * The implementation lives in sibling modules; this file keeps the command
 * registration and re-exports the public surface unchanged:
 *   - update-github.ts    — GitHub auth, asset name, latest-release fetch
 *   - update-check.ts     — cached update check
 *   - update-download.ts  — verified download + install with rollback
 *   - update-reinstall.ts — plugin reinstall (in-process and via new binary)
 */

import type { Command } from "commander";
import { runAutoSetup } from "./auto-setup.js";
import { warnIfSidecarStale } from "./sidecar-staleness.js";
import { getSentinalVersion } from "../../sidecar/version.js";
import { checkForUpdate } from "./update-check.js";
import { downloadAndInstall } from "./update-download.js";
import {
  reinstallPlugins,
  runPostUpdateReinstall,
} from "./update-reinstall.js";

export { getAssetName, fetchLatestRelease } from "./update-github.js";
export {
  type UpdateCheckResult,
  checkForUpdate,
  checkForUpdateWithStore,
} from "./update-check.js";
export {
  type DownloadAndInstallOptions,
  downloadAndInstall,
} from "./update-download.js";
export {
  type PostUpdateReinstallOptions,
  reinstallPlugins,
  runPostUpdateReinstall,
} from "./update-reinstall.js";

// ─── Register command ────────────────────────────────────────────────────────

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Check for and install updates from GitHub Releases")
    .option("--check", "Check only, don't install")
    .option(
      "--reinstall-plugins",
      "(internal) reinstall plugins using this binary's embedded assets",
    )
    .action(async (opts: { check?: boolean; reinstallPlugins?: boolean }) => {
      // Internal mode: invoked by runPostUpdateReinstall() as a subprocess of
      // the NEWLY downloaded binary. Only reinstalls — never downloads or
      // re-spawns, so recursion is impossible by construction.
      if (opts.reinstallPlugins) {
        await reinstallPlugins();
        // Provision semantic search ONCE per update, after both installers
        // ran. This executes in the NEW binary (runPostUpdateReinstall
        // spawns `<new-binary> update --reinstall-plugins`). Non-fatal.
        await runAutoSetup("update");
        // This binary is the NEW version; see sidecar-staleness.ts (also heals).
        await warnIfSidecarStale(getSentinalVersion());
        return;
      }

      const version = getSentinalVersion();

      if (opts.check) {
        const result = await checkForUpdate(version);

        if (result.updateAvailable) {
          console.log(
            `Update available: v${version} → v${result.latestVersion}` +
              (result.releaseUrl ? ` (${result.releaseUrl})` : ""),
          );
          console.log(`Run 'sentinal update' to install.`);
        } else {
          console.log(`Up to date (v${version}).`);
        }
        return;
      }

      const installed = await downloadAndInstall(version);
      if (!installed) process.exit(1);

      // After binary update, reinstall plugins for the same assistants.
      // Runs via the NEW binary so fresh embedded assets are deployed.
      try {
        await runPostUpdateReinstall({ installedVersion: installed });
      } catch (e) {
        console.error(
          `\nWarning: Plugin reinstall failed: ${(e as Error).message}`,
        );
        console.error(
          "  The binary was updated successfully. Run 'sentinal install' manually to reinstall plugins.",
        );
      }
    });
}
