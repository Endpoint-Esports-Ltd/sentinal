/**
 * Update — GitHub Releases access
 *
 * Auth headers, platform → asset-name mapping, the latest-release fetch, and
 * the one place a release tag is turned into a comparable version string.
 * Split out of update.ts; re-exported from there.
 */

import type { FetchLike } from "./update-verify.js";
import { parseSemver } from "../../utils/semver.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const GITHUB_REPO = "Endpoint-Esports-Ltd/sentinal";
const GITHUB_API_BASE = "https://api.github.com";
const RELEASE_URL = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`;

// ─── GitHub auth ─────────────────────────────────────────────────────────────

/** Read a GitHub token from the environment (GITHUB_TOKEN or GH_TOKEN). */
export function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

/** Build common headers for GitHub API requests, with auth if available. */
export function getGitHubHeaders(
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

// ─── Release version ─────────────────────────────────────────────────────────

/**
 * Turn a release tag into the version string we compare and cache:
 * `MAJOR.MINOR.PATCH` when the tag is plain semver (a leading `v` and
 * surrounding whitespace dropped), otherwise the raw tag unchanged —
 * `parseSemver` rejects prereleases, so those stay raw too.
 */
export function normalizeReleaseVersion(tag: string): string {
  const parsed = parseSemver(tag);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : tag;
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

export interface GitHubRelease {
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

/**
 * Explain a failed latest-release request. The repository is public, so a
 * token is optional: without one the likely cause of a 403/429 is the
 * unauthenticated rate limit; with one, a 401/403 means the token is bad.
 */
function releaseErrorMessage(status: number, hasToken: boolean): string | null {
  if (status === 404) {
    return (
      "GitHub API returned 404. No releases have been published yet " +
      "(or the release was not found)."
    );
  }
  if (!hasToken) {
    if (status === 403 || status === 429) {
      return (
        `GitHub API returned ${status}. The API rate limit was likely hit ` +
        "(the unauthenticated limit is 60 requests/hour).\n" +
        "  Set GITHUB_TOKEN or GH_TOKEN to raise it."
      );
    }
    if (status === 401) {
      return "GitHub API returned 401: unexpected authentication error without a token.";
    }
    return null;
  }
  if (status === 401) {
    return (
      "GitHub API returned 401. The token may be invalid or expired.\n" +
      "  Refresh it, or unset GITHUB_TOKEN/GH_TOKEN to use unauthenticated access."
    );
  }
  if (status === 403 || status === 429) {
    return (
      `GitHub API returned ${status}. The token may be invalid or expired, ` +
      "or the API rate limit was hit.\n" +
      "  Refresh the token or try again later; unset GITHUB_TOKEN/GH_TOKEN to use unauthenticated access."
    );
  }
  return null;
}

/** Fetch the latest release from GitHub API. Returns null on any failure. */
export async function fetchLatestRelease(
  fetchFn: FetchLike = fetch,
): Promise<GitHubRelease | null> {
  try {
    const response = await fetchFn(RELEASE_URL, {
      headers: getGitHubHeaders(),
      signal: AbortSignal.timeout(15_000), // 15 second timeout for API calls
    });

    if (!response.ok) {
      const message = releaseErrorMessage(response.status, !!getGitHubToken());
      if (message) console.error(message);
      return null;
    }

    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  }
}
