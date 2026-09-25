import { describe, expect, test } from "bun:test";
import { normalizeReleaseVersion } from "./update-github.js";

describe("normalizeReleaseVersion", () => {
  test("strips a leading v from a release tag", () => {
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
  });

  test("keeps a prerelease tag raw (parseSemver rejects prereleases)", () => {
    expect(normalizeReleaseVersion("v2.0.0-beta.1")).toBe("v2.0.0-beta.1");
  });

  test("trims surrounding whitespace from a semver tag", () => {
    expect(normalizeReleaseVersion(" v3.4.5 ")).toBe("3.4.5");
  });

  test("returns a bare semver tag unchanged", () => {
    expect(normalizeReleaseVersion("10.20.30")).toBe("10.20.30");
  });

  test("falls back to the raw tag when it is not semver", () => {
    expect(normalizeReleaseVersion("nightly")).toBe("nightly");
  });
});
