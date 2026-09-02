/**
 * Update Verification (M8)
 *
 * Download integrity + install-with-rollback helpers for `sentinal update`.
 * Extracted from update.ts so the verification logic is unit-testable against
 * tmp paths and injected fetch — and to keep update.ts under the 600-line
 * hard block.
 *
 * Guarantees added around the (already correct) temp-write → chmod →
 * backup-rename → atomic-rename ordering:
 *
 *  1. Size:      downloaded bytes must equal the release asset's `size`.
 *  2. Checksum:  SHA-256 verified against the release's `checksums.txt`
 *                — BEST-EFFORT by design: a missing/unfetchable/malformed
 *                checksums file downgrades to size-only verification with a
 *                visible note. Rationale: older releases may not publish
 *                checksums.txt, and the asset fetch can 403/404 without a
 *                token on private repos — failing the whole update for a
 *                missing OPTIONAL artifact would strand users on old
 *                versions, while the size check still guards truncation.
 *                A checksum that IS present and does NOT match is a hard
 *                reject.
 *  3. Smoke:     the old binary's `.bak` survives until the NEW binary has
 *                proven itself by answering `--version` (bounded timeout).
 *                Any failure — non-zero exit, timeout, spawn error — restores
 *                the `.bak` over the new binary. Every hook and CLI dispatch
 *                flows through this binary; a corrupt install must never
 *                brick it.
 */

import {
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal fetch shape — injectable so tests never touch the network. */
export type FetchLike = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ReleaseAssetRef {
  name: string;
  url: string;
  browser_download_url: string;
}

export interface SmokeResult {
  ok: boolean;
  detail?: string;
}

export type SmokeFn = (binPath: string) => SmokeResult | Promise<SmokeResult>;

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-256 of a byte buffer as lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ─── checksums.txt parsing ───────────────────────────────────────────────────

/**
 * Find the SHA-256 for `assetName` in sha256sum-format content
 * (`<hex><space><space-or-*><filename>`). Returns null when the asset has no
 * line or its line is malformed — callers treat both as "checksum
 * unavailable" (best-effort), never as a verification failure.
 */
export function parseChecksumFor(
  content: string,
  assetName: string,
): string | null {
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+\*?(\S+)$/);
    if (!match) continue;
    if (match[2] !== assetName) continue;
    const hash = match[1]!.toLowerCase();
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  }
  return null;
}

// ─── Checksum fetch (best-effort) ────────────────────────────────────────────

export interface ExpectedChecksum {
  /** The expected SHA-256 hex, or null when unavailable (best-effort). */
  sha256: string | null;
  /** Human-readable reason when sha256 is null. */
  note?: string;
}

/**
 * Fetch `checksums.txt` from the release assets and extract the expected
 * SHA-256 for `assetName`.
 *
 * BEST-EFFORT: every failure mode (no checksums.txt asset, fetch error,
 * non-2xx, malformed line) returns `{ sha256: null, note }` rather than
 * throwing — see the module docstring for why a missing checksum must not
 * fail the update.
 */
export async function fetchExpectedChecksum(opts: {
  assets: ReleaseAssetRef[];
  assetName: string;
  fetchFn: FetchLike;
  headers: Record<string, string>;
  /** Use the API asset URL (private repos, with token) vs the browser URL. */
  preferApiUrl: boolean;
}): Promise<ExpectedChecksum> {
  const checksumAsset = opts.assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) {
    return {
      sha256: null,
      note: "release has no checksums.txt — verified size only",
    };
  }

  try {
    const url = opts.preferApiUrl
      ? checksumAsset.url
      : checksumAsset.browser_download_url;
    const response = await opts.fetchFn(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        sha256: null,
        note: `checksums.txt fetch failed (HTTP ${response.status}) — verified size only`,
      };
    }
    const sha = parseChecksumFor(await response.text(), opts.assetName);
    if (!sha) {
      return {
        sha256: null,
        note: `checksums.txt has no valid entry for ${opts.assetName} — verified size only`,
      };
    }
    return { sha256: sha };
  } catch (err) {
    return {
      sha256: null,
      note: `checksums.txt fetch failed (${(err as Error).message}) — verified size only`,
    };
  }
}

// ─── Streaming download with size check + hash ───────────────────────────────

export interface DownloadedAsset {
  data: Uint8Array;
  sha256: string;
}

/**
 * Stream a release asset to memory, hashing while streaming (no second pass
 * over the ~50MB buffer) and reporting progress. Rejects with an `error`
 * when the byte count does not match the asset's declared size — a truncated
 * download must never reach the install step.
 */
export async function downloadAssetVerified(opts: {
  url: string;
  expectedSize: number;
  fetchFn: FetchLike;
  headers: Record<string, string>;
  /** Progress sink — defaults to stdout; injectable to silence tests. */
  onProgress?: (downloaded: number, total: number) => void;
}): Promise<DownloadedAsset | { error: string }> {
  const response = await opts.fetchFn(opts.url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(120_000), // 2 min for large binaries
  });

  if (!response.ok) {
    return { error: `Download failed: HTTP ${response.status}` };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { error: "Download failed: No response body" };
  }

  const hasher = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    hasher.update(value);
    downloaded += value.length;
    opts.onProgress?.(downloaded, opts.expectedSize);
  }

  if (downloaded !== opts.expectedSize) {
    return {
      error:
        `Download size mismatch: got ${downloaded} bytes, ` +
        `release declares ${opts.expectedSize}. Refusing to install a ` +
        `truncated or corrupt binary.`,
    };
  }

  const data = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  return { data, sha256: hasher.digest("hex") };
}

// ─── --version smoke test ────────────────────────────────────────────────────

/**
 * Prove the freshly installed binary can execute: run `<binPath> --version`
 * with a bounded timeout. Non-zero exit, timeout, and spawn errors all
 * return `ok: false` — the caller rolls back on any of them.
 */
export function runVersionSmoke(
  binPath: string,
  timeoutMs = 15_000,
): SmokeResult {
  const result = spawnSync(binPath, ["--version"], {
    timeout: timeoutMs,
    stdio: "ignore",
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      detail:
        code === "ETIMEDOUT"
          ? `--version timed out after ${timeoutMs}ms`
          : `spawn failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { ok: false, detail: `--version exited with code ${result.status}` };
  }
  return { ok: true };
}

// ─── Install with rollback ───────────────────────────────────────────────────

export interface InstallResult {
  ok: boolean;
  reason?: string;
}

/**
 * Install `data` at `binPath`, keeping the previous binary as `.bak` until
 * the new one passes the smoke test.
 *
 * Ordering (unchanged from the audit-approved original):
 *   temp-write → chmod → backup-rename → atomic rename
 * New: the `.bak` is only deleted AFTER `smoke` succeeds. On smoke failure
 * (or throw), the `.bak` is renamed back over the new binary — rename(2)
 * replaces atomically — so the old binary answers again.
 */
export async function installWithRollback(opts: {
  data: Uint8Array;
  binDir: string;
  binPath: string;
  smoke: SmokeFn;
}): Promise<InstallResult> {
  const { binDir, binPath } = opts;
  const tmpPath = `${binPath}.tmp`;
  const backupPath = `${binPath}.bak`;

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  try {
    await Bun.write(tmpPath, opts.data);
    chmodSync(tmpPath, 0o755);
  } catch (err) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    return { ok: false, reason: `write failed: ${(err as Error).message}` };
  }

  const hadPrevious = existsSync(binPath);
  if (hadPrevious) {
    renameSync(binPath, backupPath);
  }
  renameSync(tmpPath, binPath);

  // The new binary must prove itself before the backup is discarded.
  let smoke: SmokeResult;
  try {
    smoke = await opts.smoke(binPath);
  } catch (err) {
    smoke = {
      ok: false,
      detail: `smoke test threw: ${(err as Error).message}`,
    };
  }

  if (smoke.ok) {
    if (existsSync(backupPath)) unlinkSync(backupPath);
    return { ok: true };
  }

  // Rollback: restore the old binary over the failed new one.
  if (hadPrevious) {
    renameSync(backupPath, binPath); // atomic replace
  } else if (existsSync(binPath)) {
    unlinkSync(binPath); // fresh install — just remove the bad binary
  }
  return {
    ok: false,
    reason: `new binary failed verification (${smoke.detail ?? "unknown"}) — previous binary restored`,
  };
}
