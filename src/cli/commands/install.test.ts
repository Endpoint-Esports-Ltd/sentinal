/**
 * Install Command Tests — Deep Merge
 */

import { describe, it, expect } from "bun:test";
import { deepMergeAdditive } from "./install.js";

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
