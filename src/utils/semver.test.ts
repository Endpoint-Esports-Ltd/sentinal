import { describe, expect, test } from "bun:test";
import {
  parseSemver,
  compareSemver,
  isNewerVersion,
  findLatestTag,
} from "./semver.js";

describe("parseSemver", () => {
  test("parses plain version", () => {
    const v = parseSemver("1.2.3");
    expect(v).toEqual({ major: 1, minor: 2, patch: 3, raw: "1.2.3" });
  });

  test("parses v-prefixed version", () => {
    const v = parseSemver("v1.0.9");
    expect(v).toEqual({ major: 1, minor: 0, patch: 9, raw: "v1.0.9" });
  });

  test("parses V-prefixed version", () => {
    const v = parseSemver("V2.0.0");
    expect(v).toEqual({ major: 2, minor: 0, patch: 0, raw: "V2.0.0" });
  });

  test("trims whitespace", () => {
    const v = parseSemver("  v1.0.0  ");
    expect(v).toEqual({ major: 1, minor: 0, patch: 0, raw: "v1.0.0" });
  });

  test("rejects pre-release tags", () => {
    expect(parseSemver("v1.0.0-beta.1")).toBeNull();
    expect(parseSemver("1.0.0-rc.1")).toBeNull();
    expect(parseSemver("v2.0.0-alpha")).toBeNull();
  });

  test("rejects invalid formats", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("v1")).toBeNull();
    expect(parseSemver("v1.2")).toBeNull();
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("v1.2.3.4")).toBeNull();
    expect(parseSemver("v1.2.x")).toBeNull();
  });
});

describe("compareSemver", () => {
  test("equal versions", () => {
    const a = parseSemver("1.0.0")!;
    const b = parseSemver("1.0.0")!;
    expect(compareSemver(a, b)).toBe(0);
  });

  test("major version difference", () => {
    const a = parseSemver("1.0.0")!;
    const b = parseSemver("2.0.0")!;
    expect(compareSemver(a, b)).toBe(-1);
    expect(compareSemver(b, a)).toBe(1);
  });

  test("minor version difference", () => {
    const a = parseSemver("1.1.0")!;
    const b = parseSemver("1.2.0")!;
    expect(compareSemver(a, b)).toBe(-1);
    expect(compareSemver(b, a)).toBe(1);
  });

  test("patch version difference", () => {
    const a = parseSemver("1.0.1")!;
    const b = parseSemver("1.0.9")!;
    expect(compareSemver(a, b)).toBe(-1);
    expect(compareSemver(b, a)).toBe(1);
  });

  test("complex comparison", () => {
    const a = parseSemver("1.9.9")!;
    const b = parseSemver("2.0.0")!;
    expect(compareSemver(a, b)).toBe(-1);
  });
});

describe("isNewerVersion", () => {
  test("remote is newer", () => {
    expect(isNewerVersion("1.0.9", "v1.1.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "v2.0.0")).toBe(true);
  });

  test("remote is same", () => {
    expect(isNewerVersion("1.0.9", "v1.0.9")).toBe(false);
  });

  test("remote is older", () => {
    expect(isNewerVersion("1.1.0", "v1.0.9")).toBe(false);
  });

  test("returns false for invalid versions", () => {
    expect(isNewerVersion("invalid", "v1.0.0")).toBe(false);
    expect(isNewerVersion("v1.0.0", "invalid")).toBe(false);
  });

  test("returns false for pre-release remote", () => {
    expect(isNewerVersion("1.0.0", "v2.0.0-beta.1")).toBe(false);
  });
});

describe("findLatestTag", () => {
  test("finds latest from mixed tags", () => {
    const tags = ["v1.0.0", "v1.0.9", "v1.1.0", "v0.9.0"];
    const latest = findLatestTag(tags);
    expect(latest).toEqual({ major: 1, minor: 1, patch: 0, raw: "v1.1.0" });
  });

  test("skips pre-release tags", () => {
    const tags = ["v1.0.0", "v2.0.0-beta.1", "v1.0.9"];
    const latest = findLatestTag(tags);
    expect(latest).toEqual({ major: 1, minor: 0, patch: 9, raw: "v1.0.9" });
  });

  test("skips invalid tags", () => {
    const tags = ["release-1", "nightly", "v1.0.0"];
    const latest = findLatestTag(tags);
    expect(latest).toEqual({ major: 1, minor: 0, patch: 0, raw: "v1.0.0" });
  });

  test("returns null for empty list", () => {
    expect(findLatestTag([])).toBeNull();
  });

  test("returns null for all invalid tags", () => {
    expect(findLatestTag(["latest", "nightly", "v1.0.0-rc.1"])).toBeNull();
  });
});
