/**
 * Semver Comparison Utility
 *
 * Pure functions for parsing and comparing semantic version strings.
 * Handles `vMAJOR.MINOR.PATCH` format. Pre-release tags are excluded from comparison.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/**
 * Parse a version string into a SemVer object.
 * Accepts formats: "1.2.3", "v1.2.3". Returns null for invalid or pre-release versions.
 */
export function parseSemver(version: string): SemVer | null {
  const trimmed = version.trim();
  // Strip leading 'v' or 'V'
  const raw = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;

  // Reject pre-release tags (e.g., "1.0.0-beta.1", "1.0.0-rc.1")
  if (raw.includes("-")) return null;

  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: trimmed,
  };
}

/**
 * Compare two SemVer objects.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/**
 * Check if `remote` is newer than `current`.
 * Accepts raw version strings (e.g., "v1.2.3", "1.2.3").
 * Returns false if either version is invalid or pre-release.
 */
export function isNewerVersion(current: string, remote: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(remote);
  if (!a || !b) return false;
  return compareSemver(b, a) === 1;
}

/**
 * Find the latest stable version tag from a list of tag strings.
 * Filters out pre-release tags and returns the highest version, or null if none valid.
 */
export function findLatestTag(tags: string[]): SemVer | null {
  let latest: SemVer | null = null;
  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (!latest || compareSemver(parsed, latest) === 1) {
      latest = parsed;
    }
  }
  return latest;
}
