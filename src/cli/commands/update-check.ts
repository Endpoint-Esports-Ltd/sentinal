/**
 * Update — cached update check
 *
 * `sentinal update --check` and the CLI's startup nag. The latest version is
 * cached in SQLite settings with a 24h TTL. Split out of update.ts;
 * re-exported from there.
 */

import { MemoryStore } from "../../memory/store.js";
import { isNewerVersion } from "../../utils/semver.js";
import {
  fetchLatestRelease,
  normalizeReleaseVersion,
} from "./update-github.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const SETTINGS_KEY_LAST_CHECK = "update_last_check";
export const SETTINGS_KEY_LATEST_VERSION = "update_latest_version";

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

  const remoteVersion = normalizeReleaseVersion(release.tag_name);

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
