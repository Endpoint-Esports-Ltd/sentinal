import { describe, it, expect } from "bun:test";
import {
  formatStatusline,
  buildProgressBar,
  detectPlanTier,
  extractRateLimits,
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
  it("should extract rate_limit data from session JSON", () => {
    const result = extractRateLimits({
      rate_limit: {
        session_used_percentage: 42,
        weekly_used_percentage: 17,
      },
    });
    expect(result).toEqual({ sessionPct: 42, weeklyPct: 17 });
  });

  it("should return null when rate_limit is missing", () => {
    expect(extractRateLimits({})).toBeNull();
  });

  it("should return null when rate_limit has non-number values", () => {
    expect(
      extractRateLimits({ rate_limit: { session_used_percentage: "bad" } }),
    ).toBeNull();
  });

  it("should handle rate_limit with only session percentage", () => {
    const result = extractRateLimits({
      rate_limit: { session_used_percentage: 50 },
    });
    expect(result).toEqual({ sessionPct: 50, weeklyPct: undefined });
  });

  it("should round fractional percentages", () => {
    const result = extractRateLimits({
      rate_limit: {
        session_used_percentage: 42.7,
        weekly_used_percentage: 17.3,
      },
    });
    expect(result).toEqual({ sessionPct: 43, weeklyPct: 17 });
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
});
