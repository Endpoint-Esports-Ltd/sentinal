/**
 * Tests for update-verify.ts — M8 download verification + rollback.
 *
 * Everything here runs against tmp paths and in-memory bytes. No network,
 * no touching the real installed binary.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  sha256Hex,
  parseChecksumFor,
  fetchExpectedChecksum,
  runVersionSmoke,
  installWithRollback,
} from "./update-verify.js";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const enc = new TextEncoder();

describe("sha256Hex", () => {
  test("matches the known SHA-256 vector for 'abc'", () => {
    expect(sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseChecksumFor", () => {
  const hex = "a".repeat(64);

  test("finds the hash for the named asset (two-space sha256sum format)", () => {
    const content = `${"b".repeat(64)}  other-file\n${hex}  sentinal-darwin-arm64\n`;
    expect(parseChecksumFor(content, "sentinal-darwin-arm64")).toBe(hex);
  });

  test("handles the binary-mode '*' filename marker", () => {
    const content = `${hex} *sentinal-linux-x64\n`;
    expect(parseChecksumFor(content, "sentinal-linux-x64")).toBe(hex);
  });

  test("returns null when the asset has no line", () => {
    expect(
      parseChecksumFor(`${hex}  something-else\n`, "sentinal-linux-x64"),
    ).toBeNull();
  });

  test("returns null for a malformed hash on our asset's line", () => {
    const content = `not-a-hash  sentinal-linux-x64\n`;
    expect(parseChecksumFor(content, "sentinal-linux-x64")).toBeNull();
  });
});

describe("fetchExpectedChecksum (best-effort)", () => {
  const assetName = "sentinal-darwin-arm64";
  const hex = "c".repeat(64);
  const checksumAsset = {
    name: "checksums.txt",
    url: "https://api.test/checksums-api",
    browser_download_url: "https://dl.test/checksums.txt",
  };

  test("returns the sha when checksums.txt is present and well-formed", async () => {
    const result = await fetchExpectedChecksum({
      assets: [checksumAsset],
      assetName,
      fetchFn: async () => new Response(`${hex}  ${assetName}\n`),
      headers: {},
      preferApiUrl: false,
    });
    expect(result.sha256).toBe(hex);
  });

  test("no checksums.txt asset → null sha with a note (does NOT fail)", async () => {
    const result = await fetchExpectedChecksum({
      assets: [],
      assetName,
      fetchFn: async () => new Response("unreachable"),
      headers: {},
      preferApiUrl: false,
    });
    expect(result.sha256).toBeNull();
    expect(result.note).toBeString();
  });

  test("unfetchable checksums.txt → null sha with a note", async () => {
    const result = await fetchExpectedChecksum({
      assets: [checksumAsset],
      assetName,
      fetchFn: async () => new Response("nope", { status: 500 }),
      headers: {},
      preferApiUrl: false,
    });
    expect(result.sha256).toBeNull();
    expect(result.note).toBeString();
  });

  test("fetch throwing → null sha with a note", async () => {
    const result = await fetchExpectedChecksum({
      assets: [checksumAsset],
      assetName,
      fetchFn: async () => {
        throw new Error("network down");
      },
      headers: {},
      preferApiUrl: false,
    });
    expect(result.sha256).toBeNull();
    expect(result.note).toBeString();
  });

  test("malformed line for our asset → null sha with a note", async () => {
    const result = await fetchExpectedChecksum({
      assets: [checksumAsset],
      assetName,
      fetchFn: async () => new Response(`garbage  ${assetName}\n`),
      headers: {},
      preferApiUrl: false,
    });
    expect(result.sha256).toBeNull();
    expect(result.note).toBeString();
  });
});

describe("runVersionSmoke", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sentinal-smoke-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function script(body: string): string {
    const p = join(tmpDir, "fake-binary");
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("exit 0 → ok", () => {
    const result = runVersionSmoke(script("exit 0"), 5_000);
    expect(result.ok).toBe(true);
  });

  test("non-zero exit → not ok", () => {
    const result = runVersionSmoke(script("exit 1"), 5_000);
    expect(result.ok).toBe(false);
    expect(result.detail).toBeString();
  });

  test("hang beyond the timeout → not ok", () => {
    const result = runVersionSmoke(script("sleep 30"), 500);
    expect(result.ok).toBe(false);
  }, 10_000);

  test("spawn failure (missing binary) → not ok", () => {
    const result = runVersionSmoke(join(tmpDir, "does-not-exist"), 5_000);
    expect(result.ok).toBe(false);
  });
});

describe("installWithRollback", () => {
  let tmpDir: string;
  let binDir: string;
  let binPath: string;
  const OLD = "old-binary-contents";
  const NEW = enc.encode("new-binary-contents");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sentinal-install-test-"));
    binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    binPath = join(binDir, "sentinal");
    writeFileSync(binPath, OLD);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("smoke passes → new binary installed, .bak deleted", async () => {
    const result = await installWithRollback({
      data: NEW,
      binDir,
      binPath,
      smoke: () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(binPath, "utf-8")).toBe("new-binary-contents");
    expect(existsSync(`${binPath}.bak`)).toBe(false);
    expect(existsSync(`${binPath}.tmp`)).toBe(false);
  });

  test("smoke fails → old binary restored over the new one", async () => {
    const result = await installWithRollback({
      data: NEW,
      binDir,
      binPath,
      smoke: () => ({ ok: false, detail: "exit code 1" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeString();
    // The OLD binary must be back in place — this is the rollback.
    expect(readFileSync(binPath, "utf-8")).toBe(OLD);
    expect(existsSync(`${binPath}.bak`)).toBe(false);
    expect(existsSync(`${binPath}.tmp`)).toBe(false);
  });

  test("smoke throws → treated as failure, old binary restored", async () => {
    const result = await installWithRollback({
      data: NEW,
      binDir,
      binPath,
      smoke: () => {
        throw new Error("spawn EACCES");
      },
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(binPath, "utf-8")).toBe(OLD);
    expect(existsSync(`${binPath}.bak`)).toBe(false);
  });

  test("async smoke is awaited", async () => {
    const result = await installWithRollback({
      data: NEW,
      binDir,
      binPath,
      smoke: async () => ({ ok: false, detail: "timed out" }),
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(binPath, "utf-8")).toBe(OLD);
  });

  test("fresh install (no previous binary) with failing smoke → bad binary removed", async () => {
    rmSync(binPath);
    const result = await installWithRollback({
      data: NEW,
      binDir,
      binPath,
      smoke: () => ({ ok: false, detail: "exit code 1" }),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(`${binPath}.bak`)).toBe(false);
  });

  test("creates the bin dir when missing", async () => {
    const freshDir = join(tmpDir, "nested", "bin");
    const freshPath = join(freshDir, "sentinal");
    const result = await installWithRollback({
      data: NEW,
      binDir: freshDir,
      binPath: freshPath,
      smoke: () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(freshPath, "utf-8")).toBe("new-binary-contents");
  });
});
