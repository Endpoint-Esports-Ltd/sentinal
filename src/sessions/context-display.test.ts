/**
 * Context Display Utilities Tests
 *
 * Tests the shared formatting functions used by both Claude Code and OpenCode.
 */

import { describe, it, expect } from "bun:test";
import {
  formatTokens,
  formatContextBar,
  getContextWarning,
} from "./context-display";
import type { ContextUsage } from "./context";

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
  it("should handle zero", () => {
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatContextBar", () => {
  it("should render empty bar at 0%", () => {
    const bar = formatContextBar(0, 0);
    expect(bar).toBe("Context: [░░░░░░░░░░░░░░░░░░░░] 0% | 0 tokens");
  });

  it("should render full bar at 100%", () => {
    const bar = formatContextBar(100, 167000);
    expect(bar).toBe("Context: [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓] 100% | ~167k tokens");
  });

  it("should respect custom width", () => {
    const bar = formatContextBar(50, 83000, 10);
    expect(bar).toBe("Context: [▓▓▓▓▓░░░░░] 50% | ~83k tokens");
  });

  it("should clamp values above 100", () => {
    const bar = formatContextBar(120, 200000);
    expect(bar).toContain("▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓");
    expect(bar).not.toContain("░");
  });
});

describe("getContextWarning", () => {
  it("should return null below 80%", () => {
    expect(getContextWarning(usage(79))).toBeNull();
  });

  it("should warn at 80% with bar", () => {
    const r = getContextWarning(usage(80, 133000));
    expect(r).not.toBeNull();
    expect(r).toContain("▓");
    expect(r).toContain("Work normally");
  });

  it("should strongly warn at 90%", () => {
    const r = getContextWarning(usage(90, 150000));
    expect(r).not.toBeNull();
    expect(r).toContain("don't start complex");
  });

  it("should urge at 95%+", () => {
    const r = getContextWarning(usage(95, 158000));
    expect(r).not.toBeNull();
    expect(r).toContain("imminent");
  });

  it("should include bar as first line", () => {
    const r = getContextWarning(usage(85, 142000));
    expect(r).not.toBeNull();
    const lines = r!.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toStartWith("Context: [");
  });
});
