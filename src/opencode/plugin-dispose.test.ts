/**
 * plugin-dispose — extracted OpenCode plugin teardown.
 *
 * RED phase: fails until src/opencode/plugin-dispose.ts exists.
 *
 * OpenCode 1.18.3 has no native `dispose` plugin hook (verified in the
 * 2026-07-17 spike), so this logic is invoked from the `session.deleted`
 * branch — but extracted here so it is testable and ready to wire to a
 * native dispose hook when one ships.
 */

import { describe, it, expect } from "bun:test";
import { disposePlugin, type DisposeDeps } from "./plugin-dispose.js";

function makeDeps(overrides: Partial<DisposeDeps> = {}): {
  deps: DisposeDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: DisposeDeps = {
    sessionId: "s1",
    endSession: async () => {
      calls.push("endSession");
    },
    getActiveSessions: async () => {
      calls.push("getActiveSessions");
      return [];
    },
    stopDashboard: () => {
      calls.push("stopDashboard");
    },
    stopSidecar: () => {
      calls.push("stopSidecar");
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("disposePlugin", () => {
  it("ends the session and stops sidecar+dashboard when no active sessions remain", async () => {
    const { deps, calls } = makeDeps({ getActiveSessions: async () => [] });
    await disposePlugin(deps);
    expect(calls).toContain("endSession");
    expect(calls).toContain("stopDashboard");
    expect(calls).toContain("stopSidecar");
  });

  it("does NOT stop sidecar/dashboard when other active sessions remain", async () => {
    const { deps, calls } = makeDeps({
      getActiveSessions: async () => [{ id: "other" }],
    });
    await disposePlugin(deps);
    expect(calls).toContain("endSession");
    expect(calls).not.toContain("stopDashboard");
    expect(calls).not.toContain("stopSidecar");
  });

  it("is a no-op (no throw) when sessionId is absent", async () => {
    const { deps, calls } = makeDeps({ sessionId: undefined });
    await disposePlugin(deps);
    expect(calls).not.toContain("endSession");
  });

  it("never throws when endSession rejects", async () => {
    const { deps } = makeDeps({
      endSession: async () => {
        throw new Error("sidecar down");
      },
    });
    await expect(disposePlugin(deps)).resolves.toBeUndefined();
  });

  it("never throws when getActiveSessions rejects (skips shutdown safely)", async () => {
    const { deps, calls } = makeDeps({
      getActiveSessions: async () => {
        throw new Error("unreachable");
      },
    });
    await expect(disposePlugin(deps)).resolves.toBeUndefined();
    // Shutdown must not run if we couldn't confirm zero active sessions
    expect(calls).not.toContain("stopSidecar");
  });
});
