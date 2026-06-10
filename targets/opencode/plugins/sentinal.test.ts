import { describe, expect, it } from "bun:test";
// NOTE: import the .ts source explicitly — a stale tracked sentinal.js
// artifact in this directory would otherwise shadow it in bun's resolution.
import {
  SentinalPlugin,
  ensureDashboardForTest,
  parseBinaryVersion,
} from "./sentinal.ts";

/**
 * parseBinaryVersion — regression guard for the 2026-06-10 incident where a
 * mid-update binary printed the literal string "undefined" for --version,
 * which sailed past the `?? "unknown"` guard and triggered a version-mismatch
 * respawn ("running=1.30.0 current=undefined"). Only MAJOR.MINOR.PATCH...
 * stdout counts as a version; anything else is null (= unknown, no respawn).
 */
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
});

/**
 * Plugin load smoke test.
 *
 * Regression guard for the v1.29.0 incident where the plugin referenced an
 * undefined `context` binding inside its init body. `bun build` does not
 * type-check and the root tsconfig only includes src/**, so a plain
 * ReferenceError at init silently killed the ENTIRE plugin in OpenCode
 * ("error=context is not defined failed to load plugin") — disabling the TDD
 * guard, memory observer, and all other handlers for the session.
 *
 * Calling the plugin function with a realistic mock context catches any
 * init-time throw at test time.
 */
describe("SentinalPlugin init (load smoke)", () => {
  function mockContext(overrides: Record<string, unknown> = {}) {
    return {
      project: { id: "test", worktree: "/tmp/sentinal-plugin-load-test" },
      client: {
        app: { log: async () => {} },
        session: { messages: async () => ({ data: [] }) },
      },
      $: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      directory: "/tmp/sentinal-plugin-load-test",
      worktree: "/tmp/sentinal-plugin-load-test",
      ...overrides,
    } as never;
  }

  it("initializes without throwing and returns hook handlers", async () => {
    const hooks = await SentinalPlugin(mockContext());
    expect(hooks).toBeDefined();
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  }, 30_000);

  it("registers the workspace adaptor when experimental_workspace is available", async () => {
    const registered: Array<{ type: string; adaptor: unknown }> = [];
    await SentinalPlugin(
      mockContext({
        experimental_workspace: {
          register: (type: string, adaptor: unknown) =>
            registered.push({ type, adaptor }),
        },
      }),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]!.type).toBe("sentinal-spec-worktree");
  }, 30_000);

  it("initializes without experimental_workspace (older OpenCode)", async () => {
    const hooks = await SentinalPlugin(mockContext());
    expect(hooks).toBeDefined();
  }, 30_000);
});

// ─── ensureDashboard logic ────────────────────────────────────────────────────

describe("ensureDashboardForTest", () => {
  it("should spawn when health probe returns null (not running)", async () => {
    let spawned = false;
    await ensureDashboardForTest({
      currentVersion: "1.30.1",
      probeFn: async () => null,
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(true);
  });

  it("should not spawn when same version is live", async () => {
    let spawned = false;
    await ensureDashboardForTest({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.1", pid: 1234 }),
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(false);
  });

  it("should spawn when different version is live (serve handles takeover)", async () => {
    let spawned = false;
    await ensureDashboardForTest({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.0", pid: 1234 }),
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(true);
  });

  it("should not throw when spawnFn throws", async () => {
    await expect(
      ensureDashboardForTest({
        currentVersion: "1.30.1",
        probeFn: async () => null,
        spawnFn: () => { throw new Error("spawn failed"); },
      })
    ).resolves.toBeUndefined();
  });
});
