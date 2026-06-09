/**
 * Update Command
 *
 * `sentinal update` — Check for and install updates from GitHub Releases.
 * `sentinal update --check` — Check only, don't install.
 *
 * Downloads platform-specific pre-built binary from GitHub Release assets.
 * Caches update check timestamp in SQLite settings (24h TTL).
 */

import type { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "../../memory/store.js";
import { isNewerVersion, parseSemver } from "../../utils/semver.js";
import {
  detectInstalledTargets,
  uninstallClaudeCode,
  uninstallOpenCode,
} from "./uninstall.js";
import { installClaudeCode, installOpenCode } from "./install.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const GITHUB_REPO = "Endpoint-Esports-Ltd/sentinal";
const GITHUB_API_BASE = "https://api.github.com";
const RELEASE_URL = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BIN_DIR = join(homedir(), ".sentinal", "bin");
const BIN_PATH = join(BIN_DIR, "sentinal");

const SETTINGS_KEY_LAST_CHECK = "update_last_check";
const SETTINGS_KEY_LATEST_VERSION = "update_latest_version";

// ─── GitHub auth ─────────────────────────────────────────────────────────────

/** Read a GitHub token from the environment (GITHUB_TOKEN or GH_TOKEN). */
function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

/** Build common headers for GitHub API requests, with auth if available. */
function getGitHubHeaders(
  accept = "application/vnd.github.v3+json",
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "sentinal-updater",
  };
  const token = getGitHubToken();
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

// ─── Platform mapping ────────────────────────────────────────────────────────

/** Map Node.js platform/arch to GitHub Release asset name. */
export function getAssetName(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") return "sentinal-linux-x64";
  if (platform === "linux" && arch === "arm64") return "sentinal-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "sentinal-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "sentinal-darwin-arm64";

  return null;
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  assets: Array<{
    name: string;
    url: string;
    browser_download_url: string;
    size: number;
  }>;
}

/** Fetch the latest release from GitHub API. Returns null on any failure. */
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(RELEASE_URL, {
      headers: getGitHubHeaders(),
      signal: AbortSignal.timeout(15_000), // 15 second timeout for API calls
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403 || status === 404) {
        if (!getGitHubToken()) {
          console.error(
            `GitHub API returned ${status}. ` +
              "For private repos, set GITHUB_TOKEN or GH_TOKEN with 'repo' scope.\n" +
              "  Create a token at: https://github.com/settings/tokens",
          );
        } else if (status === 404) {
          console.error(
            "GitHub API returned 404. This usually means no releases have been published yet,\n" +
              "  or the token lacks 'repo' scope for this private repository.",
          );
        } else {
          console.error(
            `GitHub API returned ${status}. The token may lack 'repo' scope.\n` +
              "  Verify your GITHUB_TOKEN has access to this private repository.",
          );
        }
      }
      return null;
    }

    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

// ─── Update check (cached) ──────────────────────────────────────────────────

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  fromCache: boolean;
}

/**
 * Check for updates with 24h caching.
 * Returns the check result without installing anything.
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<UpdateCheckResult> {
  const store = new MemoryStore();
  try {
    return await checkForUpdateWithStore(store, currentVersion);
  } finally {
    store.close();
  }
}

/** Check for updates using a provided store (for testability). */
export async function checkForUpdateWithStore(
  store: MemoryStore,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  // Check cache
  const lastCheck = store.getSetting(SETTINGS_KEY_LAST_CHECK);
  const cachedVersion = store.getSetting(SETTINGS_KEY_LATEST_VERSION);

  if (lastCheck && cachedVersion) {
    const elapsed = Date.now() - parseInt(lastCheck, 10);
    if (elapsed < CHECK_INTERVAL_MS) {
      return {
        updateAvailable: isNewerVersion(currentVersion, cachedVersion),
        currentVersion,
        latestVersion: cachedVersion,
        releaseUrl: null,
        fromCache: true,
      };
    }
  }

  // Fetch from GitHub
  const release = await fetchLatestRelease();
  if (!release) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: cachedVersion ?? null,
      releaseUrl: null,
      fromCache: false,
    };
  }

  const remoteParsed = parseSemver(release.tag_name);
  const remoteVersion = remoteParsed
    ? `${remoteParsed.major}.${remoteParsed.minor}.${remoteParsed.patch}`
    : release.tag_name;

  // Update cache
  store.setSetting(SETTINGS_KEY_LAST_CHECK, String(Date.now()));
  store.setSetting(SETTINGS_KEY_LATEST_VERSION, remoteVersion);

  return {
    updateAvailable: isNewerVersion(currentVersion, remoteVersion),
    currentVersion,
    latestVersion: remoteVersion,
    releaseUrl: release.html_url,
    fromCache: false,
  };
}

// ─── Binary download ─────────────────────────────────────────────────────────

/**
 * Download and install the latest binary for the current platform.
 * Returns true on success.
 */
export async function downloadAndInstall(
  currentVersion: string,
): Promise<boolean> {
  const assetName = getAssetName();
  if (!assetName) {
    console.error(
      `Unsupported platform: ${process.platform}-${process.arch}. ` +
        `Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64`,
    );
    return false;
  }

  console.log("Checking for updates...");

  const release = await fetchLatestRelease();
  if (!release) {
    console.error("Failed to fetch release information from GitHub.");
    return false;
  }

  const remoteParsed = parseSemver(release.tag_name);
  const remoteVersion = remoteParsed
    ? `${remoteParsed.major}.${remoteParsed.minor}.${remoteParsed.patch}`
    : release.tag_name;

  if (!isNewerVersion(currentVersion, remoteVersion)) {
    console.log(`Already up to date (v${currentVersion}).`);
    return true;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.error(
      `No binary found for ${assetName} in release ${release.tag_name}.\n` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`,
    );
    return false;
  }

  console.log(
    `Downloading v${remoteVersion} (${assetName}, ${formatBytes(asset.size)})...`,
  );

  try {
    // For private repos, browser_download_url returns 404. Use the API URL
    // with Accept: application/octet-stream which redirects to a signed URL.
    const downloadUrl = getGitHubToken()
      ? asset.url
      : asset.browser_download_url;
    const response = await fetch(downloadUrl, {
      headers: getGitHubHeaders("application/octet-stream"),
      signal: AbortSignal.timeout(120_000), // 2 minute timeout for large binaries
    });

    if (!response.ok) {
      console.error(`Download failed: HTTP ${response.status}`);
      return false;
    }

    // Stream the response with progress indicator
    const totalSize = asset.size;
    const reader = response.body?.getReader();
    if (!reader) {
      console.error("Download failed: No response body");
      return false;
    }

    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    let lastPercent = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;

      const percent = Math.floor((downloaded / totalSize) * 100);
      if (percent !== lastPercent && percent % 10 === 0) {
        process.stdout.write(
          `\r  ${percent}% (${formatBytes(downloaded)} / ${formatBytes(totalSize)})`,
        );
        lastPercent = percent;
      }
    }
    process.stdout.write("\r  100% — Download complete.                    \n");

    // Combine chunks into a single buffer
    const data = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }

    // Ensure bin directory exists
    if (!existsSync(BIN_DIR)) {
      mkdirSync(BIN_DIR, { recursive: true });
    }

    // Atomic replace: write to temp, rename
    const tmpPath = `${BIN_PATH}.tmp`;
    const backupPath = `${BIN_PATH}.bak`;

    await Bun.write(tmpPath, data);
    chmodSync(tmpPath, 0o755);

    // Backup existing binary
    if (existsSync(BIN_PATH)) {
      renameSync(BIN_PATH, backupPath);
    }

    // Atomic move
    renameSync(tmpPath, BIN_PATH);

    // Clean up backup
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }

    // Update cache
    const store = new MemoryStore();
    try {
      store.setSetting(SETTINGS_KEY_LAST_CHECK, String(Date.now()));
      store.setSetting(SETTINGS_KEY_LATEST_VERSION, remoteVersion);
    } finally {
      store.close();
    }

    console.log(`Updated to v${remoteVersion} successfully.`);
    console.log(`Binary: ${BIN_PATH}`);
    return true;
  } catch (err) {
    console.error(`Download failed: ${(err as Error).message}`);
    return false;
  }
}

// ─── Plugin reinstall ────────────────────────────────────────────────────────

/**
 * Detect which assistants have Sentinal installed, uninstall old plugin data
 * (preserving binary/shell/npm), then reinstall for the same targets.
 *
 * Called after a successful binary download. Failures are non-fatal —
 * the binary is already updated; user can manually `sentinal install`.
 */
export async function reinstallPlugins(): Promise<void> {
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
}

/** Default spawner: run the command synchronously, inheriting stdio. */
function spawnReinstall(cmd: string[]): number {
  const { spawnSync } = require("node:child_process") as {
    spawnSync: (
      command: string,
      args: string[],
      options: { stdio: "inherit" },
    ) => { status: number | null; error?: Error };
  };
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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
        return;
      }

      const version = getVersionForUpdate();

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

      const success = await downloadAndInstall(version);
      if (!success) process.exit(1);

      // After binary update, reinstall plugins for the same assistants.
      // Runs via the NEW binary so fresh embedded assets are deployed.
      try {
        await runPostUpdateReinstall();
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

/** Get current version — same pattern as other CLI commands. */
declare const __SENTINAL_VERSION__: string | undefined;

function getVersionForUpdate(): string {
  if (typeof __SENTINAL_VERSION__ !== "undefined") {
    return __SENTINAL_VERSION__;
  }
  try {
    const { readFileSync } = require("node:fs");
    const { join: joinPath, dirname: dirnamePath } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = joinPath(
      dirnamePath(__filename),
      "..",
      "..",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
