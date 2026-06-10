import { describe, expect, it } from "bun:test";
// NOTE: import the .ts source explicitly — a stale tracked sentinal.js
// artifact in this directory would otherwise shadow it in bun's resolution.
// NOTE: parseBinaryVersion / ensureDashboard helper tests moved to
// src/opencode/dashboard-ensure.test.ts — the helpers no longer live in (or
// export from) this module because OpenCode invokes every plugin-module
// export as a plugin factory (see src/opencode/plugin-exports.test.ts).
import { SentinalPlugin } from "./sentinal.ts";
import { ensureDashboard } from "../../../src/opencode/dashboard-ensure.js";

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

describe("ensureDashboard", () => {
  it("should spawn when health probe returns null (not running)", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => null,
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(true);
  });

  it("should not spawn when same version is live", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.1", pid: 1234 }),
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(false);
  });

  it("should spawn when different version is live (serve handles takeover)", async () => {
    let spawned = false;
    await ensureDashboard({
      currentVersion: "1.30.1",
      probeFn: async () => ({ version: "1.30.0", pid: 1234 }),
      spawnFn: () => { spawned = true; },
    });
    expect(spawned).toBe(true);
  });

  it("should not throw when spawnFn throws", async () => {
    await expect(
      ensureDashboard({
        currentVersion: "1.30.1",
        probeFn: async () => null,
        spawnFn: () => { throw new Error("spawn failed"); },
      })
    ).resolves.toBeUndefined();
  });
});
