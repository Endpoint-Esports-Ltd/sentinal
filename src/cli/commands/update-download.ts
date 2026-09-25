/**
 * Update — binary download + verified install
 *
 * Downloads the platform-specific pre-built binary from the latest GitHub
 * Release, verifies it (size, SHA-256, `--version` smoke) and installs it with
 * rollback. Split out of update.ts; re-exported from there.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "../../memory/store.js";
import {
  type FetchLike,
  type SmokeFn,
  fetchExpectedChecksum,
  downloadAssetVerified,
  runVersionSmoke,
  installWithRollback,
} from "./update-verify.js";
import { isNewerVersion } from "../../utils/semver.js";
import {
  fetchLatestRelease,
  getAssetName,
  getGitHubHeaders,
  getGitHubToken,
  normalizeReleaseVersion,
} from "./update-github.js";
import {
  SETTINGS_KEY_LAST_CHECK,
  SETTINGS_KEY_LATEST_VERSION,
} from "./update-check.js";

export const BIN_DIR = join(homedir(), ".sentinal", "bin");
export const BIN_PATH = join(BIN_DIR, "sentinal");

/** Injection seam for tests — no network, no real binary paths. */
export interface DownloadAndInstallOptions {
  fetchFn?: FetchLike;
  binDir?: string;
  binPath?: string;
  smoke?: SmokeFn;
}

/**
 * Download and install the latest binary for the current platform.
 * Returns the installed (or already-current) version, or null on failure.
 *
 * Verification (M8): downloaded bytes must match the asset's declared size;
 * the SHA-256 is checked against the release's checksums.txt (best-effort —
 * see update-verify.ts for why a MISSING checksum does not fail the update);
 * and the old binary's .bak is kept until the new binary answers
 * `--version`, rolling back on any failure.
 */
export async function downloadAndInstall(
  currentVersion: string,
  opts: DownloadAndInstallOptions = {},
): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const binDir = opts.binDir ?? BIN_DIR;
  const binPath = opts.binPath ?? BIN_PATH;
  const smoke = opts.smoke ?? ((p: string) => runVersionSmoke(p));
  const assetName = getAssetName();
  if (!assetName) {
    console.error(
      `Unsupported platform: ${process.platform}-${process.arch}. ` +
        `Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64`,
    );
    return null;
  }

  console.log("Checking for updates...");

  const release = await fetchLatestRelease(fetchFn);
  if (!release) {
    console.error("Failed to fetch release information from GitHub.");
    return null;
  }

  const remoteVersion = normalizeReleaseVersion(release.tag_name);

  if (!isNewerVersion(currentVersion, remoteVersion)) {
    console.log(`Already up to date (v${currentVersion}).`);
    return currentVersion;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.error(
      `No binary found for ${assetName} in release ${release.tag_name}.\n` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`,
    );
    return null;
  }

  console.log(
    `Downloading v${remoteVersion} (${assetName}, ${formatBytes(asset.size)})...`,
  );

  try {
    // For private repos, browser_download_url returns 404. Use the API URL
    // with Accept: application/octet-stream which redirects to a signed URL.
    const useApiUrl = Boolean(getGitHubToken());
    const downloadUrl = useApiUrl ? asset.url : asset.browser_download_url;

    // Stream + hash + size-check (M8: a truncated download is rejected
    // before anything on disk is touched).
    let lastPercent = -1;
    const downloadResult = await downloadAssetVerified({
      url: downloadUrl,
      expectedSize: asset.size,
      fetchFn,
      headers: getGitHubHeaders("application/octet-stream"),
      onProgress: (downloaded, total) => {
        const percent = Math.floor((downloaded / total) * 100);
        if (percent !== lastPercent && percent % 10 === 0) {
          process.stdout.write(
            `\r  ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`,
          );
          lastPercent = percent;
        }
      },
    });
    if ("error" in downloadResult) {
      process.stdout.write("\n");
      console.error(downloadResult.error);
      return null;
    }
    process.stdout.write("\r  100% — Download complete.                    \n");

    // Checksum verification — best-effort by design (see update-verify.ts):
    // a missing/unfetchable checksums.txt downgrades to size-only with a
    // note; a PRESENT checksum that mismatches is a hard reject.
    const expected = await fetchExpectedChecksum({
      assets: release.assets,
      assetName,
      fetchFn,
      headers: getGitHubHeaders("application/octet-stream"),
      preferApiUrl: useApiUrl,
    });
    if (expected.sha256) {
      if (expected.sha256 !== downloadResult.sha256) {
        console.error(
          `Checksum mismatch for ${assetName}:\n` +
            `  expected ${expected.sha256}\n` +
            `  actual   ${downloadResult.sha256}\n` +
            `Refusing to install a corrupt binary.`,
        );
        return null;
      }
      console.log("  SHA-256 checksum verified.");
    } else {
      console.log(`  Note: ${expected.note}`);
    }

    // Install keeping the .bak until the new binary passes --version (M8).
    const install = await installWithRollback({
      data: downloadResult.data,
      binDir,
      binPath,
      smoke,
    });
    if (!install.ok) {
      console.error(`Update failed: ${install.reason}`);
      return null;
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
    console.log(`Binary: ${binPath}`);
    return remoteVersion;
  } catch (err) {
    console.error(`Download failed: ${(err as Error).message}`);
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
