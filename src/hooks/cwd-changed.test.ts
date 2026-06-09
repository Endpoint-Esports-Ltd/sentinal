/**
 * CwdChanged Hook Tests
 *
 * Tests for the hook that invalidates project-context cache
 * when the working directory changes.
 */

import { describe, it, expect, mock } from "bun:test";
import { processCwdChanged } from "./cwd-changed.js";
import type { HookInput } from "../utils/hook-output.js";

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "test-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/old/project",
    permission_mode: "default",
    hook_event_name: "CwdChanged",
    old_cwd: "/old/project",
    new_cwd: "/new/project",
    ...overrides,
  };
}

describe("processCwdChanged", () => {
  it("should call invalidateProjectContext when sidecar is available", async () => {
    const invalidateCalled: string[] = [];
    const mockClient = {
      invalidateProjectContext: async (projectPath: string) => {
        invalidateCalled.push(projectPath);
      },
    };

    // Mock SidecarClient.connect to return our mock client
    const cwdChangedModule = await import("./cwd-changed.js");
    const original = cwdChangedModule.connectSidecar;

    // Temporarily replace the connectSidecar export
    // We'll test by providing a mock connect function
    const input = makeInput({ new_cwd: "/new/project" });

    // Use the exported function with a mock injected
    await cwdChangedModule.processCwdChanged(
      input,
      async () => mockClient as never,
    );

    expect(invalidateCalled).toHaveLength(1);
    expect(invalidateCalled[0]).toBe("/new/project");

    void original;
  });

  it("should return silently when sidecar is not available (null)", async () => {
    const cwdChangedModule = await import("./cwd-changed.js");
    const input = makeInput({ new_cwd: "/new/project" });

    // Pass a connect function that returns null (sidecar unavailable)
    await expect(
      cwdChangedModule.processCwdChanged(input, async () => null),
    ).resolves.toBeUndefined();
  });

  it("should use new_cwd as the project path to invalidate", async () => {
    const invalidatedPaths: string[] = [];
    const mockClient = {
      invalidateProjectContext: async (projectPath: string) => {
        invalidatedPaths.push(projectPath);
      },
    };

    const cwdChangedModule = await import("./cwd-changed.js");
    const input = makeInput({ old_cwd: "/old/dir", new_cwd: "/new/dir" });

    await cwdChangedModule.processCwdChanged(
      input,
      async () => mockClient as never,
    );

    expect(invalidatedPaths[0]).toBe("/new/dir");
  });

  it("should handle errors from sidecar gracefully", async () => {
    const mockClient = {
      invalidateProjectContext: async (_projectPath: string) => {
        throw new Error("Sidecar connection lost");
      },
    };

    const cwdChangedModule = await import("./cwd-changed.js");
    const input = makeInput();

    // Should not throw even when sidecar errors
    await expect(
      cwdChangedModule.processCwdChanged(
        input,
        async () => mockClient as never,
      ),
    ).resolves.toBeUndefined();
  });
});
