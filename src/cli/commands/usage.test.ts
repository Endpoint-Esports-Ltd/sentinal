import { describe, it, expect } from "bun:test";
import {
  formatUsageReport,
  formatUsageBar,
  type UsageReportInput,
} from "./usage.js";

describe("formatUsageBar", () => {
  it("should render a visual bar with percentage", () => {
    const bar = formatUsageBar(50, 20);
    expect(bar).toContain("▓");
    expect(bar).toContain("░");
    expect(bar.indexOf("▓")).toBeLessThan(bar.indexOf("░"));
  });

  it("should handle 0%", () => {
    const bar = formatUsageBar(0, 10);
    expect(bar).toBe("░".repeat(10));
  });

  it("should handle 100%", () => {
    const bar = formatUsageBar(100, 10);
    expect(bar).toBe("▓".repeat(10));
  });
});

describe("formatUsageReport", () => {
  const sampleInput: UsageReportInput = {
    planTier: "Max 5x",
    weeklyResetCountdown: "2d 5h",
    modelSummary: [
      {
        name: "claude-opus-4-6",
        displayName: "Opus",
        inputTokens: 50000,
        outputTokens: 20000,
        costEquiv: 1.35,
        pctOfLimit: 5,
        resetsIn: "4h 12m",
      },
      {
        name: "claude-sonnet-4-6",
        displayName: "Sonnet",
        inputTokens: 100000,
        outputTokens: 30000,
        costEquiv: 0.75,
        pctOfLimit: 3,
        resetsIn: "4h 12m",
      },
    ],
    totalCostEquiv: 2.1,
    totalPctOfLimit: 8,
    dailyUsage: [
      {
        date: "2026-03-09",
        totalCostEquiv: 0.8,
        totalInputTokens: 40000,
        totalOutputTokens: 12000,
      },
      {
        date: "2026-03-10",
        totalCostEquiv: 1.3,
        totalInputTokens: 110000,
        totalOutputTokens: 38000,
      },
    ],
  };

  it("should include plan tier header", () => {
    const report = formatUsageReport(sampleInput);
    expect(report).toContain("Max 5x");
  });

  it("should include model breakdown", () => {
    const report = formatUsageReport(sampleInput);
    expect(report).toContain("Opus");
    expect(report).toContain("Sonnet");
    expect(report).toContain("5%");
    expect(report).toContain("3%");
  });

  it("should include daily breakdown", () => {
    const report = formatUsageReport(sampleInput);
    expect(report).toContain("2026-03-09");
    expect(report).toContain("2026-03-10");
  });

  it("should include weekly reset countdown", () => {
    const report = formatUsageReport(sampleInput);
    expect(report).toContain("2d 5h");
  });

  it("should include total percentage", () => {
    const report = formatUsageReport(sampleInput);
    expect(report).toContain("8%");
  });

  it("should format as JSON when json flag is set", () => {
    const report = formatUsageReport(sampleInput, true);
    const parsed = JSON.parse(report);
    expect(parsed.planTier).toBe("Max 5x");
    expect(parsed.modelSummary).toHaveLength(2);
    expect(parsed.dailyUsage).toHaveLength(2);
  });
});
