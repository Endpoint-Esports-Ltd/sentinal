// Unit tests for the pure helpers in release-asset.ts.
// These are standard .test.ts so they run in the default `bun test` suite (no network).

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  assetNameFor,
  parseChecksums,
  verifyChecksum,
  selectAssetIds,
  downloadReleaseAsset,
} from "./release-asset.js";

describe("assetNameFor", () => {
  it("maps darwin/arm64 to sentinal-darwin-arm64", () => {
    expect(assetNameFor("darwin", "arm64")).toBe("sentinal-darwin-arm64");
  });

  it("maps linux/x64 to sentinal-linux-x64", () => {
    expect(assetNameFor("linux", "x64")).toBe("sentinal-linux-x64");
  });

  it("normalizes amd64 to x64", () => {
    expect(assetNameFor("linux", "amd64")).toBe("sentinal-linux-x64");
  });

  it("normalizes x86_64 to x64", () => {
    expect(assetNameFor("linux", "x86_64")).toBe("sentinal-linux-x64");
  });

  it("normalizes aarch64 to arm64", () => {
    expect(assetNameFor("darwin", "aarch64")).toBe("sentinal-darwin-arm64");
  });

  it("throws on unsupported OS", () => {
    expect(() => assetNameFor("windows", "x64")).toThrow("Unsupported OS");
  });

  it("throws on unsupported architecture", () => {
    expect(() => assetNameFor("linux", "riscv64")).toThrow(
      "Unsupported architecture",
    );
  });
});

describe("parseChecksums", () => {
  it("parses a multi-line fixture into a basename->sha map", () => {
    const text = [
      "aaaa1111  sentinal-darwin-arm64",
      "bbbb2222  sentinal-linux-x64",
      "cccc3333  sentinal-linux-arm64",
    ].join("\n");
    const map = parseChecksums(text);
    expect(map.get("sentinal-darwin-arm64")).toBe("aaaa1111");
    expect(map.get("sentinal-linux-x64")).toBe("bbbb2222");
    expect(map.get("sentinal-linux-arm64")).toBe("cccc3333");
    expect(map.size).toBe(3);
  });

  it("ignores blank lines", () => {
    const text = [
      "",
      "aaaa1111  sentinal-darwin-arm64",
      "   ",
      "bbbb2222  sentinal-linux-x64",
      "",
    ].join("\n");
    const map = parseChecksums(text);
    expect(map.size).toBe(2);
    expect(map.get("sentinal-darwin-arm64")).toBe("aaaa1111");
  });
});

describe("verifyChecksum", () => {
  const buf = Buffer.from("hello sentinal");
  const expected = createHash("sha256").update(buf).digest("hex");

  it("returns true for a matching sha256", () => {
    expect(verifyChecksum(buf, expected)).toBe(true);
  });

  it("returns false for a wrong sha256", () => {
    expect(verifyChecksum(buf, "0".repeat(64))).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(verifyChecksum(buf, expected.toUpperCase())).toBe(true);
  });
});

describe("selectAssetIds", () => {
  const releaseJson = {
    assets: [
      { id: 1, name: "sentinal-darwin-arm64" },
      { id: 2, name: "checksums.txt" },
      { id: 3, name: "sentinal-linux-x64" },
    ],
  };

  it("selects the exact binary id and the checksums.txt id", () => {
    const ids = selectAssetIds(releaseJson, "sentinal-darwin-arm64");
    expect(ids).toEqual({ binaryId: 1, checksumsId: 2 });
  });

  it("throws when the asset name is missing", () => {
    expect(() => selectAssetIds(releaseJson, "sentinal-freebsd-x64")).toThrow();
  });

  it("does not partial-match a substring", () => {
    // "sentinal-darwin" must NOT match "sentinal-darwin-arm64"
    expect(() => selectAssetIds(releaseJson, "sentinal-darwin")).toThrow();
  });

  it("throws when checksums.txt is missing", () => {
    const noChecksums = {
      assets: [{ id: 1, name: "sentinal-darwin-arm64" }],
    };
    expect(() =>
      selectAssetIds(noChecksums, "sentinal-darwin-arm64"),
    ).toThrow();
  });
});

describe("downloadReleaseAsset (mismatch path, monkeypatched fetch)", () => {
  it("throws when the downloaded binary sha256 does not match checksums.txt", async () => {
    const origFetch = globalThis.fetch;
    const binaryBytes = Buffer.from("this is the fake binary payload");
    // Deliberately WRONG checksum for the binary.
    const wrongSha = "0".repeat(64);
    const checksumsText = `${wrongSha}  sentinal-darwin-arm64\n`;

    const releaseJson = {
      assets: [
        { id: 10, name: "sentinal-darwin-arm64" },
        { id: 11, name: "checksums.txt" },
      ],
    };

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/releases/latest") || url.includes("/releases/tags/")) {
        return new Response(JSON.stringify(releaseJson), { status: 200 });
      }
      if (url.endsWith("/assets/10")) {
        return new Response(binaryBytes, { status: 200 });
      }
      if (url.endsWith("/assets/11")) {
        return new Response(checksumsText, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const tmpDir = `/tmp/sentinal-release-asset-test-${Date.now()}`;
    try {
      await expect(
        downloadReleaseAsset({
          token: "fake-token",
          destDir: tmpDir,
          platform: "darwin",
          arch: "arm64",
        }),
      ).rejects.toThrow(/checksum/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
