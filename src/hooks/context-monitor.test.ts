import { describe, expect, it } from "bun:test";
import {
  getContextWarning,
  formatContextBar,
  formatTokens,
} from "./context-monitor";
import type { ContextUsage } from "../sessions/context";

function usage(percent: number, tokens = 0): ContextUsage {
  return { percent, tokens, fileBytes: tokens * 3 };
}

describe("formatTokens", () => {
  it("should format small counts as-is", () => {
    expect(formatTokens(500)).toBe("500");
  });
  it("should format thousands with ~Nk", () => {
    expect(formatTokens(133000)).toBe("~133k");
  });
  it("should round thousands", () => {
    expect(formatTokens(1500)).toBe("~2k");
  });
  it("should handle exactly 1000", () => {
    expect(formatTokens(1000)).toBe("~1k");
  });
});

describe("formatContextBar", () => {
  it("should render empty bar at 0%", () => {
    const bar = formatContextBar(0, 0);
    expect(bar).toBe("Context: [░░░░░░░░░░░░░░░░░░░░] 0% | 0 tokens");
  });

  it("should render half-filled bar at 50%", () => {
    const bar = formatContextBar(50, 83000);
    expect(bar).toBe("Context: [▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░] 50% | ~83k tokens");
  });

  it("should render mostly-filled bar at 80%", () => {
    const bar = formatContextBar(80, 133000);
    expect(bar).toBe("Context: [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░] 80% | ~133k tokens");
  });

  it("should render nearly-full bar at 95%", () => {
    const bar = formatContextBar(95, 158000);
    expect(bar).toBe("Context: [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░] 95% | ~158k tokens");
  });

  it("should render full bar at 100%", () => {
    const bar = formatContextBar(100, 167000);
    expect(bar).toBe("Context: [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓] 100% | ~167k tokens");
  });

  it("should clamp values above 100", () => {
    const bar = formatContextBar(120, 200000);
    // Filled count should be clamped to width (20)
    expect(bar).toContain("▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
    expect(bar).not.toContain("░");
  });

  it("should respect custom width", () => {
    const bar = formatContextBar(50, 83000, 10);
    expect(bar).toBe("Context: [▓▓▓▓▓░░░░░] 50% | ~83k tokens");
  });
});

describe("getContextWarning", () => {
  it("should return null below 80%", () => {
    expect(getContextWarning(usage(70))).toBeNull();
  });

  it("should return null at exactly 79%", () => {
    expect(getContextWarning(usage(79))).toBeNull();
  });

  it("should warn at 80% with bar", () => {
    const r = getContextWarning(usage(80, 133000));
    expect(r).not.toBeNull();
    expect(r).toContain("80%");
    expect(r).toContain("▓");
    expect(r).toContain("░");
    expect(r).toContain("~133k tokens");
    expect(r).toContain("Work normally");
  });

  it("should strongly warn at 90% with bar", () => {
    const r = getContextWarning(usage(90, 150000));
    expect(r).not.toBeNull();
    expect(r).toContain("90%");
    expect(r).toContain("▓");
    expect(r).toContain("don't start complex");
  });

  it("should urge completion at 95%+ with bar", () => {
    const r = getContextWarning(usage(95, 158000));
    expect(r).not.toBeNull();
    expect(r!.toLowerCase()).toContain("complete");
    expect(r).toContain("▓");
    expect(r).toContain("imminent");
  });

  it("should urge completion at 100%", () => {
    const r = getContextWarning(usage(100, 167000));
    expect(r).not.toBeNull();
    expect(r).toContain("100%");
    expect(r).toContain("▓");
  });

  it("should include bar as first line", () => {
    const r = getContextWarning(usage(85, 142000));
    expect(r).not.toBeNull();
    const lines = r!.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toStartWith("Context: [");
    expect(lines[0]).toContain("~142k tokens");
  });
});
