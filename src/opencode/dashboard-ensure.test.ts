import { describe, expect, it } from "bun:test";
import { parseBinaryVersion, ensureDashboard } from "./dashboard-ensure.js";

describe("parseBinaryVersion", () => {
  it("accepts plain semver", () => {
    expect(parseBinaryVersion("1.31.1\n")).toBe("1.31.1");
  });

  it("accepts prerelease/build suffixes", () => {
    expect(parseBinaryVersion("1.31.1-beta.2")).toBe("1.31.1-beta.2");
    expect(parseBinaryVersion("2.0.0+build.5\n")).toBe("2.0.0+build.5");
  });

  it("rejects the literal string 'undefined'", () => {
    expect(parseBinaryVersion("undefined")).toBeNull();
    expect(parseBinaryVersion("undefined\n")).toBeNull();
  });

  it("rejects empty and garbage output", () => {
    expect(parseBinaryVersion("")).toBeNull();
    expect(parseBinaryVersion("   \n")).toBeNull();
    expect(parseBinaryVersion("error: something broke")).toBeNull();
    expect(parseBinaryVersion("v1.2.3")).toBeNull(); // binary prints bare semver, no v-prefix
  });

  it("never throws on non-string input (Buffer, undefined, null, number, object)", () => {
    expect(parseBinaryVersion(Buffer.from("1.31.3\n") as unknown as string)).toBe("1.31.3");
    expect(parseBinaryVersion(undefined as unknown as string)).toBeNull();
    expect(parseBinaryVersion(null as unknown as string)).toBeNull();
    expect(parseBinaryVersion(42 as unknown as string)).toBeNull();
    expect(parseBinaryVersion({} as unknown as string)).toBeNull();
  });
});

describe("ensureDashboard", () => {
  it("skips spawn when same version is already running", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.31.4",
      probeFn: async () => ({ version: "1.31.4", pid: 42 }),
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(false);
  });

  it("spawns on version mismatch", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.31.4",
      probeFn: async () => ({ version: "1.30.1", pid: 42 }),
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(true);
  });

  it("spawns when not running", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.31.4",
      probeFn: async () => null,
      spawnFn: () => {
        spawned = true;
      },
    });
    expect(spawned).toBe(true);
  });

  it("never throws when probe or spawn fail", async () => {
    await ensureDashboard({
      currentVersion: "1.31.4",
      probeFn: async () => {
        throw new Error("probe boom");
      },
      spawnFn: () => {
        throw new Error("spawn boom");
      },
    });
    // reaching here without throwing IS the assertion
    expect(true).toBe(true);
  });
});
