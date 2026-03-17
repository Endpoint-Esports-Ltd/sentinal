import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseJsonlLogs,
  getSessionUsage,
  getUsageSummary,
  getDailyUsage,
  formatResetCountdown,
  PLAN_LIMITS,
  type UsageSummary,
} from "./usage-stats.js";

// Helper to create a JSONL log entry
function assistantEntry(
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp: string,
  cacheCreation = 0,
  cacheRead = 0,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      model,
      role: "assistant",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

function userEntry(timestamp: string): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user" } });
}

describe("parseJsonlLogs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should parse assistant messages with model and token data", () => {
    const logFile = join(tmpDir, "session.jsonl");
    const lines = [
      userEntry("2026-03-10T10:00:00Z"),
      assistantEntry("claude-opus-4-6", 1000, 500, "2026-03-10T10:00:01Z"),
      assistantEntry("claude-sonnet-4-6", 2000, 300, "2026-03-10T10:00:02Z"),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const entries = parseJsonlLogs(logFile);
    expect(entries).toHaveLength(2);
    expect(entries[0].model).toBe("claude-opus-4-6");
    expect(entries[0].inputTokens).toBe(1000);
    expect(entries[0].outputTokens).toBe(500);
    expect(entries[1].model).toBe("claude-sonnet-4-6");
  });

  it("should skip non-assistant entries", () => {
    const logFile = join(tmpDir, "session.jsonl");
    const lines = [
      userEntry("2026-03-10T10:00:00Z"),
      JSON.stringify({ type: "progress", timestamp: "2026-03-10T10:00:00Z" }),
      assistantEntry("claude-opus-4-6", 1000, 500, "2026-03-10T10:00:01Z"),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const entries = parseJsonlLogs(logFile);
    expect(entries).toHaveLength(1);
  });

  it("should return empty array for missing file", () => {
    const entries = parseJsonlLogs("/nonexistent/file.jsonl");
    expect(entries).toHaveLength(0);
  });
});

describe("getSessionUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should sum tokens by model for a session", () => {
    const logFile = join(tmpDir, "session.jsonl");
    const lines = [
      assistantEntry("claude-opus-4-6", 1000, 500, "2026-03-10T10:00:01Z"),
      assistantEntry("claude-opus-4-6", 2000, 800, "2026-03-10T10:01:01Z"),
      assistantEntry("claude-sonnet-4-6", 3000, 200, "2026-03-10T10:02:01Z"),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const usage = getSessionUsage(logFile);
    expect(usage.byModel["claude-opus-4-6"].inputTokens).toBe(3000);
    expect(usage.byModel["claude-opus-4-6"].outputTokens).toBe(1300);
    expect(usage.byModel["claude-sonnet-4-6"].inputTokens).toBe(3000);
    expect(usage.totalInputTokens).toBe(6000);
    expect(usage.totalOutputTokens).toBe(1500);
  });

  it("should return zero usage for missing file", () => {
    const usage = getSessionUsage("/nonexistent/file.jsonl");
    expect(usage.totalInputTokens).toBe(0);
    expect(usage.totalOutputTokens).toBe(0);
  });
});

describe("getDailyUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should group usage by date", () => {
    const logFile = join(tmpDir, "session.jsonl");
    const lines = [
      assistantEntry("claude-opus-4-6", 1000, 500, "2026-03-09T10:00:01Z"),
      assistantEntry("claude-opus-4-6", 2000, 800, "2026-03-10T10:01:01Z"),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const daily = getDailyUsage([logFile]);
    expect(daily).toHaveLength(2);
    expect(daily[0].date).toBe("2026-03-09");
    expect(daily[1].date).toBe("2026-03-10");
  });
});

describe("getUsageSummary", () => {
  let tmpDir: string;
  // Use a dynamic recent timestamp so entries always fall within the 7-day rolling window
  const recentTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should calculate % of plan limit", () => {
    const logFile = join(tmpDir, "session.jsonl");
    // Create entries with known cost to test percentage calculation
    const lines = [
      assistantEntry("claude-opus-4-6", 10000, 5000, recentTimestamp),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const summary = getUsageSummary([logFile], "max_5x");
    expect(summary.planTier).toBe("max_5x");
    expect(summary.byModel["claude-opus-4-6"]).toBeDefined();
    expect(
      summary.byModel["claude-opus-4-6"].pctOfLimit,
    ).toBeGreaterThanOrEqual(0);
    expect(summary.byModel["claude-opus-4-6"].pctOfLimit).toBeLessThanOrEqual(
      100,
    );
  });

  it("should respect plan tier", () => {
    const logFile = join(tmpDir, "session.jsonl");
    // Use large token counts so cost is meaningful relative to plan limits
    const lines = [
      assistantEntry("claude-opus-4-6", 500000, 200000, recentTimestamp),
    ];
    writeFileSync(logFile, lines.join("\n"));

    const summary5x = getUsageSummary([logFile], "max_5x");
    const summary20x = getUsageSummary([logFile], "max_20x");
    // 20x has 4x the limit, so pct should be ~4x smaller
    expect(summary5x.byModel["claude-opus-4-6"].pctOfLimit).toBeGreaterThan(
      summary20x.byModel["claude-opus-4-6"].pctOfLimit,
    );
  });
});

describe("formatResetCountdown", () => {
  it("should format hours and minutes", () => {
    const ms = 4 * 60 * 60 * 1000 + 12 * 60 * 1000; // 4h 12m
    expect(formatResetCountdown(ms)).toBe("4h 12m");
  });

  it("should format days and hours", () => {
    const ms = 2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000; // 2d 5h
    expect(formatResetCountdown(ms)).toBe("2d 5h");
  });

  it("should show minutes only when less than 1 hour", () => {
    const ms = 45 * 60 * 1000; // 45m
    expect(formatResetCountdown(ms)).toBe("45m");
  });

  it("should return '0m' for zero or negative", () => {
    expect(formatResetCountdown(0)).toBe("0m");
    expect(formatResetCountdown(-1000)).toBe("0m");
  });
});

describe("PLAN_LIMITS", () => {
  it("should define max_5x and max_20x limits", () => {
    expect(PLAN_LIMITS.max_5x).toBeDefined();
    expect(PLAN_LIMITS.max_20x).toBeDefined();
    expect(PLAN_LIMITS.max_20x).toBeGreaterThan(PLAN_LIMITS.max_5x);
  });
});
