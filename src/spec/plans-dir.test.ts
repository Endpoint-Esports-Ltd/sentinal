/**
 * spec/plans-dir — resolvePlansDir / resolvePlanFilePath tests
 *
 * RED phase: tests fail until src/spec/plans-dir.ts is created.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { resolvePlansDir, resolvePlanFilePath } from "./plans-dir.js";

describe("resolvePlansDir", () => {
  it("should return <worktreePath>/docs/plans when worktreePath is given", () => {
    const result = resolvePlansDir({
      worktreePath: "/my/worktree",
      cwd: "/my/project",
    });
    expect(result).toBe(join("/my/worktree", "docs", "plans"));
  });

  it("should return <cwd>/docs/plans when no worktreePath given", () => {
    const result = resolvePlansDir({ cwd: "/my/project" });
    expect(result).toBe(join("/my/project", "docs", "plans"));
  });

  it("should return <cwd>/docs/plans when worktreePath is empty string", () => {
    const result = resolvePlansDir({ worktreePath: "", cwd: "/my/project" });
    expect(result).toBe(join("/my/project", "docs", "plans"));
  });

  it("should return <cwd>/docs/plans when worktreePath is undefined", () => {
    const result = resolvePlansDir({ worktreePath: undefined, cwd: "/my/project" });
    expect(result).toBe(join("/my/project", "docs", "plans"));
  });
});

describe("resolvePlanFilePath", () => {
  it("should return plan path inside worktree docs/plans when worktreePath given", () => {
    const result = resolvePlanFilePath({
      slug: "my-feature",
      date: "2026-06-10",
      worktreePath: "/my/worktree",
      cwd: "/my/project",
    });
    expect(result).toBe(
      join("/my/worktree", "docs", "plans", "2026-06-10-my-feature.md"),
    );
  });

  it("should return plan path inside cwd docs/plans when no worktreePath", () => {
    const result = resolvePlanFilePath({
      slug: "my-feature",
      date: "2026-06-10",
      cwd: "/my/project",
    });
    expect(result).toBe(
      join("/my/project", "docs", "plans", "2026-06-10-my-feature.md"),
    );
  });

  it("should use today's date when date is omitted", () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = resolvePlanFilePath({
      slug: "no-date-feature",
      cwd: "/my/project",
    });
    expect(result).toContain(today);
    expect(result).toContain("no-date-feature.md");
  });
});
