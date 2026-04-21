import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatStatusline,
  buildProgressBar,
  detectPlanTier,
  extractRateLimits,
  extractWorktree,
  isStatuslineActive,
} from "./statusline.js";

describe("buildProgressBar", () => {
  it("should render empty bar at 0%", () => {
    expect(buildProgressBar(0, 5)).toBe("░░░░░");
  });

  it("should render full bar at 100%", () => {
    expect(buildProgressBar(100, 5)).toBe("▓▓▓▓▓");
  });

  it("should render partial bar", () => {
    expect(buildProgressBar(40, 5)).toBe("▓▓░░░");
  });

  it("should clamp to 0-100 range", () => {
    expect(buildProgressBar(-10, 5)).toBe("░░░░░");
    expect(buildProgressBar(150, 5)).toBe("▓▓▓▓▓");
  });
});

describe("detectPlanTier", () => {
  it("should return max_20x when context window size is >= 1000000", () => {
    expect(detectPlanTier(null, 1000000)).toBe("max_20x");
  });

  it("should return max_20x when context window size exceeds 1000000", () => {
    expect(detectPlanTier(null, 2000000)).toBe("max_20x");
  });

  it("should return max_5x when context window size is 200000", () => {
    expect(detectPlanTier(null, 200000)).toBe("max_5x");
  });

  it("should return max_5x when no context window size provided", () => {
    expect(detectPlanTier(null, undefined)).toBe("max_5x");
  });

  it("should use manual config over auto-detection", () => {
    expect(detectPlanTier("max_20x", 200000)).toBe("max_20x");
  });

  it("should handle quoted config value", () => {
    expect(detectPlanTier('"max_20x"', undefined)).toBe("max_20x");
  });

  it("should default to max_5x with no config and no context window", () => {
    expect(detectPlanTier(null, undefined)).toBe("max_5x");
  });
});

describe("extractRateLimits", () => {
  it("should extract nested rate_limits data from session JSON", () => {
    const result = extractRateLimits({
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: "2026-04-02T12:00:00Z" },
        seven_day: { used_percentage: 17, resets_at: "2026-04-08T00:00:00Z" },
      },
    });
    expect(result).toEqual({ sessionPct: 42, weeklyPct: 17 });
  });

  it("should return null when rate_limits is missing", () => {
    expect(extractRateLimits({})).toBeNull();
  });

  it("should return null when five_hour has non-number used_percentage", () => {
    expect(
      extractRateLimits({
        rate_limits: { five_hour: { used_percentage: "bad" } },
      }),
    ).toBeNull();
  });

  it("should handle rate_limits with only five_hour", () => {
    const result = extractRateLimits({
      rate_limits: {
        five_hour: { used_percentage: 50 },
      },
    });
    expect(result).toEqual({ sessionPct: 50, weeklyPct: undefined });
  });

  it("should round fractional percentages", () => {
    const result = extractRateLimits({
      rate_limits: {
        five_hour: { used_percentage: 42.7 },
        seven_day: { used_percentage: 17.3 },
      },
    });
    expect(result).toEqual({ sessionPct: 43, weeklyPct: 17 });
  });
});

describe("isStatuslineActive", () => {
  const testDir = join(tmpdir(), `sentinal-test-${process.pid}`);
  const settingsPath = join(testDir, "settings.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it("should return false when command points to another plugin", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "npx ccstatusline-usage" },
      }),
    );
    expect(isStatuslineActive(settingsPath)).toBe(false);
  });

  it("should return true when command contains sentinal", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "/Users/evan/.sentinal/bin/sentinal statusline",
        },
      }),
    );
    expect(isStatuslineActive(settingsPath)).toBe(true);
  });

  it("should return true when settings.json does not exist", () => {
    expect(isStatuslineActive(join(testDir, "nonexistent.json"))).toBe(true);
  });

  it("should return true when statusLine field is missing", () => {
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }));
    expect(isStatuslineActive(settingsPath)).toBe(true);
  });

  it("should return true when statusLine has no command", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command" } }),
    );
    expect(isStatuslineActive(settingsPath)).toBe(true);
  });

  it("should handle JSONC with comments", () => {
    writeFileSync(
      settingsPath,
      `{
  // This is a comment
  "statusLine": {
    "type": "command",
    "command": "npx ccstatusline-usage"
  }
}`,
    );
    expect(isStatuslineActive(settingsPath)).toBe(false);
  });
});

describe("extractWorktree", () => {
  it("should return branch when git_worktree is present", () => {
    const result = extractWorktree({
      workspace: {
        git_worktree: {
          name: "my-worktree",
          path: "/path/to/worktree",
          branch: "feature/foo",
          originalRepoDir: "/path/to/repo",
        },
      },
    });
    expect(result).toEqual({ branch: "feature/foo" });
  });

  it("should return null when workspace is absent", () => {
    expect(extractWorktree({})).toBeNull();
  });

  it("should return null when git_worktree is absent", () => {
    expect(extractWorktree({ workspace: {} })).toBeNull();
  });

  it("should return null when branch is a non-string", () => {
    expect(
      extractWorktree({
        workspace: {
          git_worktree: { branch: 42 },
        },
      }),
    ).toBeNull();
  });

  it("should return null when branch is an empty string", () => {
    expect(
      extractWorktree({
        workspace: {
          git_worktree: { branch: "" },
        },
      }),
    ).toBeNull();
  });
});

describe("formatStatusline", () => {
  it("should format with all sections", () => {
    const result = formatStatusline({
      sessionPct: 10,
      sessionDuration: "2h",
      modelUsage: [
        { name: "Opus", pct: 4 },
        { name: "Sonnet", pct: 6 },
      ],
      weeklyResetCountdown: "2d 4h",
      planTier: "Max 5x",
      contextPct: 10,
    });

    expect(result).toContain("⏱");
    expect(result).toContain("Session:");
    expect(result).toContain("10%");
    expect(result).toContain("2h");
    expect(result).toContain("Opus: 4%");
    expect(result).toContain("Sonnet: 6%");
    expect(result).toContain("2d 4h");
    expect(result).toContain("Plan: Max 5x");
    expect(result).toContain("🧠");
  });

  it("should include progress bars for session and context", () => {
    const result = formatStatusline({
      sessionPct: 50,
      sessionDuration: "1h",
      modelUsage: [],
      weeklyResetCountdown: "5d",
      planTier: "Max 5x",
      contextPct: 80,
    });

    // Should contain filled/empty bar characters
    expect(result).toContain("▓");
    expect(result).toContain("░");
  });

  it("should handle empty model usage", () => {
    const result = formatStatusline({
      sessionPct: 0,
      sessionDuration: "0m",
      modelUsage: [],
      weeklyResetCountdown: "7d 0h",
      planTier: "Max 5x",
      contextPct: 0,
    });

    expect(result).toContain("⏱");
    expect(result).toContain("Plan: Max 5x");
    expect(result).toContain("🧠");
  });

  it("should include worktree branch when workspaceBranch is set", () => {
    const result = formatStatusline({
      sessionPct: 10,
      sessionDuration: "1h",
      modelUsage: [],
      weeklyResetCountdown: "5d",
      planTier: "Max 5x",
      contextPct: 20,
      workspaceBranch: "feature/foo",
    });

    expect(result).toContain("📁 feature/foo");
  });

  it("should not include worktree section when workspaceBranch is undefined", () => {
    const result = formatStatusline({
      sessionPct: 10,
      sessionDuration: "1h",
      modelUsage: [],
      weeklyResetCountdown: "5d",
      planTier: "Max 5x",
      contextPct: 20,
    });

    expect(result).not.toContain("📁");
  });
});
