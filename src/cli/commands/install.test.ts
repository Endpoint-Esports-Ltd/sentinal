/**
 * Install Command Tests — Deep Merge + Prereq Helpers
 */

import { describe, it, expect, spyOn, afterEach, mock } from "bun:test";
import { deepMergeAdditive, checkPlaywrightCli } from "./install.js";

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
