import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import {
  fetchLatestRelease,
  normalizeReleaseVersion,
} from "./update-github.js";

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

describe("fetchLatestRelease error messages (public repo)", () => {
  let savedGithub: string | undefined;
  let savedGh: string | undefined;
  let errorSpy: Mock<(...args: unknown[]) => void>;

  beforeEach(() => {
    savedGithub = process.env.GITHUB_TOKEN;
    savedGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithub;
    if (savedGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGh;
  });

  const respond = (status: number) => async () => new Response("", { status });

  const printed = (): string =>
    errorSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

  const cases: Array<{ status: number; token: boolean }> = [
    { status: 401, token: false },
    { status: 403, token: false },
    { status: 404, token: false },
    { status: 429, token: false },
    { status: 401, token: true },
    { status: 403, token: true },
    { status: 404, token: true },
  ];

  for (const { status, token } of cases) {
    test(`${status} ${token ? "with" : "without"} token: null, no private-repo wording`, async () => {
      if (token) process.env.GITHUB_TOKEN = "ghp_test";
      const result = await fetchLatestRelease(respond(status));
      expect(result).toBeNull();
      const out = printed();
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/private/i);
      expect(out).not.toMatch(/repo' scope/);
    });
  }

  test("403 without a token mentions the rate limit", async () => {
    await fetchLatestRelease(respond(403));
    expect(printed()).toMatch(/rate limit/i);
    expect(printed()).toMatch(/GITHUB_TOKEN/);
  });

  test("429 without a token mentions the rate limit", async () => {
    await fetchLatestRelease(respond(429));
    expect(printed()).toMatch(/rate limit/i);
  });

  test("404 without a token says no releases were published", async () => {
    await fetchLatestRelease(respond(404));
    expect(printed()).toMatch(/no releases/i);
  });

  test("401 with a token says it may be invalid or expired", async () => {
    process.env.GH_TOKEN = "ghp_test";
    await fetchLatestRelease(respond(401));
    expect(printed()).toMatch(/invalid or expired/i);
  });

  test("403 with a token mentions both a rejected token and the rate limit", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    await fetchLatestRelease(respond(403));
    expect(printed()).toMatch(/invalid or expired/i);
    expect(printed()).toMatch(/rate limit/i);
  });

  test("404 with a token says no releases were published", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    await fetchLatestRelease(respond(404));
    expect(printed()).toMatch(/no releases/i);
  });
});
