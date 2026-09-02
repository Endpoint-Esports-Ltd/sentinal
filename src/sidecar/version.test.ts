/**
 * Sidecar Version Helper Tests (M2c)
 *
 * getSentinalVersion() feeds /health's `version` field and the client's
 * advisory skew check. In source mode it must resolve package.json.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSentinalVersion } from "./version.js";

describe("getSentinalVersion", () => {
  it("returns the package.json version in source mode", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8"),
    ) as { version: string };
    expect(getSentinalVersion()).toBe(pkg.version);
  });

  it("returns a non-empty string", () => {
    expect(typeof getSentinalVersion()).toBe("string");
    expect(getSentinalVersion().length).toBeGreaterThan(0);
  });
});
