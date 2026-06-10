import { describe, test, expect } from "bun:test";
import { runInstallAction } from "./install.js";

describe("runInstallAction auto-setup wiring", () => {
  test("invokes auto-setup exactly once, after the dispatcher completes", async () => {
    const calls: string[] = [];

    await runInstallAction(
      "claude",
      { local: false },
      {
        dispatcher: async () => {
          calls.push("dispatch");
        },
        autoSetup: async (label: string) => {
          calls.push(`setup:${label}`);
        },
      },
    );

    expect(calls).toEqual(["dispatch", "setup:install"]);
  });

  test("passes target and opts through to the dispatcher", async () => {
    let seenTarget: string | undefined;
    let seenOpts: unknown;

    await runInstallAction(
      "opencode",
      { local: true, bundled: true },
      {
        dispatcher: async (target, opts) => {
          seenTarget = target;
          seenOpts = opts;
        },
        autoSetup: async () => {},
      },
    );

    expect(seenTarget).toBe("opencode");
    expect(seenOpts).toEqual({ local: true, bundled: true });
  });

  test("does not run auto-setup when the dispatcher throws", async () => {
    const calls: string[] = [];

    await expect(
      runInstallAction(undefined, undefined, {
        dispatcher: async () => {
          throw new Error("install boom");
        },
        autoSetup: async () => {
          calls.push("setup");
        },
      }),
    ).rejects.toThrow("install boom");

    expect(calls).toEqual([]);
  });
});
