// Download + checksum-verify a published GitHub release asset for this repo.
//
// The repo is PRIVATE, so the network path requires a GITHUB_TOKEN. Pure helpers
// (assetNameFor, parseChecksums, verifyChecksum, selectAssetIds) are unit-tested
// in release-asset.test.ts. The network helper (downloadReleaseAsset) is gated by
// GITHUB_TOKEN at call sites and is NOT unit-tested against a real network.
//
// Reference: scripts/install.sh (os/arch to asset name, latest-release resolution,
// asset download by id with Accept: application/octet-stream). NOTE install.sh does
// NOT verify checksums; this helper verifies sha256 against checksums.txt.

import { createHash } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "Endpoint-Esports-Ltd/sentinal";
const API_BASE = "https://api.github.com";

// Map a platform string (process.platform or uname -s output) to a release OS token.
function normalizeOs(platform: string): string {
  const p = platform.trim().toLowerCase();
  switch (p) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported OS: ${platform}. Supported: linux, darwin`);
  }
}

// Map an arch string (process.arch or uname -m output) to a release arch token.
function normalizeArch(arch: string): string {
  const a = arch.trim().toLowerCase();
  switch (a) {
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(
        `Unsupported architecture: ${arch}. Supported: x64, arm64`,
      );
  }
}

// Compute the release asset name for a given platform/arch.
// Accepts process.platform/process.arch OR uname-style strings.
export function assetNameFor(platform: string, arch: string): string {
  const os = normalizeOs(platform);
  const cpu = normalizeArch(arch);
  return `sentinal-${os}-${cpu}`;
}

// Parse sha256sum-style output into a map of basename -> lowercase sha256 hex.
// Each non-blank line is `<sha256>  <filename>` (two spaces per sha256sum; we
// tolerate any run of whitespace). filename is a basename.
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = line.match(/^([0-9a-fA-F]+)\s+(.+)$/);
    if (!match) continue;
    const sha = match[1].toLowerCase();
    const name = match[2].trim();
    map.set(name, sha);
  }
  return map;
}

// Compute sha256 of the given bytes and compare (case-insensitive) to expected.
export function verifyChecksum(
  fileBytes: Uint8Array | Buffer,
  expectedSha: string,
): boolean {
  const actual = createHash("sha256")
    .update(Buffer.from(fileBytes))
    .digest("hex");
  return actual.toLowerCase() === expectedSha.trim().toLowerCase();
}

interface ReleaseAsset {
  id: number;
  name: string;
}

// Given a GitHub release API JSON object with an `assets: [{id, name}]` array,
// return the id whose name EXACTLY equals assetName and the id of "checksums.txt".
// Throws a clear error if either is missing. Exact-name match only (no substring).
export function selectAssetIds(
  releaseJson: unknown,
  assetName: string,
): { binaryId: number; checksumsId: number } {
  const assets = (releaseJson as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) {
    throw new Error("Release JSON has no assets array");
  }
  let binaryId: number | undefined;
  let checksumsId: number | undefined;
  for (const raw of assets as ReleaseAsset[]) {
    if (!raw || typeof raw.name !== "string") continue;
    if (raw.name === assetName) binaryId = raw.id;
    if (raw.name === "checksums.txt") checksumsId = raw.id;
  }
  if (binaryId === undefined) {
    throw new Error(`No release asset named "${assetName}" found`);
  }
  if (checksumsId === undefined) {
    throw new Error('No release asset named "checksums.txt" found');
  }
  return { binaryId, checksumsId };
}

interface DownloadOpts {
  tag?: string;
  token: string;
  destDir: string;
  platform?: string;
  arch?: string;
}

// Resolve the release (latest or a given tag), select the platform binary + the
// checksums.txt asset, download both by id, verify sha256 (throw on mismatch),
// write the binary to destDir/<assetName>, chmod 0o755, and return the path.
// Uses global fetch. NEVER logs the token.
export async function downloadReleaseAsset(
  opts: DownloadOpts,
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const assetName = assetNameFor(platform, arch);

  const releaseUrl = opts.tag
    ? `${API_BASE}/repos/${REPO}/releases/tags/${opts.tag}`
    : `${API_BASE}/repos/${REPO}/releases/latest`;

  const releaseRes = await fetch(releaseUrl, {
    headers: {
      Authorization: `token ${opts.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!releaseRes.ok) {
    throw new Error(
      `Failed to fetch release info (${releaseRes.status} ${releaseRes.statusText})`,
    );
  }
  const releaseJson: unknown = await releaseRes.json();
  const { binaryId, checksumsId } = selectAssetIds(releaseJson, assetName);

  const binaryBytes = await downloadAssetById(binaryId, opts.token);
  const checksumsBytes = await downloadAssetById(checksumsId, opts.token);
  const checksums = parseChecksums(Buffer.from(checksumsBytes).toString("utf8"));

  const expected = checksums.get(assetName);
  if (!expected) {
    throw new Error(`checksums.txt has no entry for "${assetName}"`);
  }
  if (!verifyChecksum(binaryBytes, expected)) {
    throw new Error(
      `Checksum mismatch for "${assetName}": downloaded asset does not match checksums.txt`,
    );
  }

  mkdirSync(opts.destDir, { recursive: true });
  const outPath = join(opts.destDir, assetName);
  writeFileSync(outPath, Buffer.from(binaryBytes));
  chmodSync(outPath, 0o755);
  return outPath;
}

// Download a single release asset by id as raw bytes (Accept: octet-stream).
async function downloadAssetById(
  id: number,
  token: string,
): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}/repos/${REPO}/releases/assets/${id}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download asset ${id} (${res.status} ${res.statusText})`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}
