/**
 * Install Command Tests — Deep Merge + Prereq Helpers
 */

import { describe, it, expect, spyOn, afterEach, mock } from "bun:test";
import {
  deepMergeAdditive,
  checkPlaywrightCli,
  buildPluginList,
} from "./install.js";

// ─── buildPluginList tests ───────────────────────────────────────────────────
//
// ⛔ The config.plugin entry is the ONLY load path for the binary-mode plugin.
// OpenCode's plugin loader (packages/opencode/src/config/plugin.ts) scans
// `{plugin,plugins}/*.{ts,js}` — `.mjs` is EXCLUDED from the glob, so
// plugins/sentinal.mjs is never directory-auto-loaded. v1.31.2 removed the
// config entry believing directory auto-load covered it, silently disabling
// the entire plugin (no TDD guard, no memory, no session tracking) with zero
// errors logged. These tests pin the entry's presence in BOTH modes.
// (The "double-load" that motivated the removal was normal per-instance
// plugin init — OpenCode initializes plugins once per instance: main,
// subagent, compaction.)

describe("buildPluginList", () => {
  const FILE_REF = "./plugins/sentinal.mjs";
  const NPM_REF = "@endpoint/sentinal/opencode-plugin";

  it("binary mode: appends the file entry (the ONLY load path — .mjs is not directory-auto-loaded)", () => {
    expect(buildPluginList(undefined, true, FILE_REF)).toEqual([FILE_REF]);
    expect(buildPluginList([], true, FILE_REF)).toEqual([FILE_REF]);
  });

  it("binary mode: dedupes — existing sentinal entries replaced by exactly one", () => {
    const result = buildPluginList(
      [FILE_REF, "opencode-wakatime", NPM_REF],
      true,
      FILE_REF,
    );
    expect(result).toEqual(["opencode-wakatime", FILE_REF]);
  });

  it("npm mode: appends the package reference exactly once", () => {
    const result = buildPluginList(["other-plugin"], false, NPM_REF);
    expect(result).toEqual(["other-plugin", NPM_REF]);
  });

  it("npm mode: replaces legacy sentinal entries with the package reference", () => {
    const result = buildPluginList(
      [FILE_REF, "other-plugin", NPM_REF],
      false,
      NPM_REF,
    );
    expect(result).toEqual(["other-plugin", NPM_REF]);
  });

  it("preserves non-sentinal plugin order in both modes", () => {
    expect(buildPluginList(["a", "b"], true, FILE_REF)).toEqual(["a", "b", FILE_REF]);
    expect(buildPluginList(["a", "b"], false, NPM_REF)).toEqual(["a", "b", NPM_REF]);
  });

  it("never returns undefined — the sentinal entry must always be present", () => {
    expect(buildPluginList(undefined, true, FILE_REF)).toBeDefined();
    expect(buildPluginList(undefined, false, NPM_REF)).toBeDefined();
  });
});

// ─── deepMergeAdditive tests ─────────────────────────────────────────────────

describe("deepMergeAdditive", () => {
  it("merges all keys into empty target", () => {
    const target = {};
    const source = { skill: { "*": "allow" }, edit: { "*": "ask" } };
    const result = deepMergeAdditive(target, source);
    expect(result).toEqual({ skill: { "*": "allow" }, edit: { "*": "ask" } });
  });

  it("adds missing keys without overwriting existing ones", () => {
    const target = { skill: { "*": "deny" } };
    const source = {
      skill: { "*": "allow", "spec-*": "allow" },
      edit: { "*": "ask" },
    };
    const result = deepMergeAdditive(target, source);
    // skill.* should NOT be overwritten (user set "deny"), but spec-* and edit should be added
    expect(result.skill).toEqual({ "*": "deny", "spec-*": "allow" });
    expect(result.edit).toEqual({ "*": "ask" });
  });

  it("recursively merges nested objects", () => {
    const target = {
      build: {
        permission: {
          task: { "*": "ask" },
        },
      },
    };
    const source = {
      build: {
        permission: {
          task: { "*": "ask", "plan-reviewer": "allow", explore: "allow" },
          edit: { "*": "allow" },
        },
      },
    };
    const result = deepMergeAdditive(target, source) as Record<string, unknown>;
    const buildPerm = (result.build as Record<string, unknown>)
      .permission as Record<string, unknown>;
    const task = buildPerm.task as Record<string, string>;
    expect(task["*"]).toBe("ask"); // preserved
    expect(task["plan-reviewer"]).toBe("allow"); // added
    expect(task["explore"]).toBe("allow"); // added
    expect(buildPerm.edit).toEqual({ "*": "allow" }); // added
  });

  it("does not overwrite scalar values (target wins)", () => {
    const target = { "*": "deny", explore: "deny" };
    const source = { "*": "ask", explore: "allow", general: "allow" };
    const result = deepMergeAdditive(target, source);
    expect(result["*"]).toBe("deny"); // target wins
    expect(result["explore"]).toBe("deny"); // target wins
    expect(result["general"]).toBe("allow"); // added
  });

  it("handles source with object and target with scalar gracefully", () => {
    const target = { edit: "deny" };
    const source = { edit: { "*": "ask", "docs/plans/*.md": "allow" } };
    const result = deepMergeAdditive(target, source);
    // target has scalar "deny" for edit — should NOT be overwritten with object
    expect(result.edit).toBe("deny");
  });

  it("handles target with object and source with scalar gracefully", () => {
    const target = { edit: { "*": "ask", custom: "allow" } };
    const source = { edit: "allow" };
    const result = deepMergeAdditive(target, source);
    // target has object, source has scalar — target wins
    expect(result.edit).toEqual({ "*": "ask", custom: "allow" });
  });
});

// ─── checkPlaywrightCli tests ────────────────────────────────────────────────
//
// `playwright-cli` is an OPTIONAL dependency needed for /spec UI verification.
// The helper must emit a soft info hint (not an error) and never exit the
// process. The correct npm package is `@playwright/cli` (scoped), NOT the
// deprecated bare `playwright-cli` package. The hint must reference the
// correct package.

describe("checkPlaywrightCli", () => {
  afterEach(() => {
    mock.restore();
  });

  it("prints [OK] line when playwright-cli is present and does not print the install hint", () => {
    const logged: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });

    // Inject a stub that reports the binary as found
    checkPlaywrightCli(() => true);

    const combined = logged.join("\n");
    expect(combined).toContain("playwright-cli");
    expect(combined).toContain("[OK]");
    expect(combined).not.toContain("npm install");
    expect(combined).not.toContain("[i]");
  });

  it("prints [i] info line AND install hint pointing at @playwright/cli when playwright-cli is missing", () => {
    const logged: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });

    // Inject a stub that reports the binary as missing
    checkPlaywrightCli(() => false);

    const combined = logged.join("\n");
    expect(combined).toContain("[i]");
    expect(combined).toContain("playwright-cli not found");
    expect(combined).toContain("optional");
    // Must point at the SCOPED package — bare `playwright-cli` is deprecated
    expect(combined).toContain("npm install -g @playwright/cli@latest");
  });

  it("does not call process.exit under any circumstance (soft warning only)", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error(
        "process.exit was called — checkPlaywrightCli must never exit",
      );
    }) as unknown as (code?: number | undefined) => never);

    expect(() => checkPlaywrightCli(() => false)).not.toThrow();
    expect(() => checkPlaywrightCli(() => true)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
