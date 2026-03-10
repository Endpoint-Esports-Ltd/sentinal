import { describe, it, expect } from "bun:test";
import { formatStatusline, buildProgressBar } from "./statusline.js";

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
