import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateContextUsage } from "./context.js";

interface FixtureEntry {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  model?: string;
  type?: string;
}

/** Write a Claude-Code-shaped JSONL transcript for testing. */
function writeTranscript(
  dir: string,
  name: string,
  entries: FixtureEntry[],
): string {
  const lines = entries.map((e) =>
    JSON.stringify({
      type: e.type ?? "assistant",
      timestamp: "2026-06-26T00:00:00.000Z",
      message: {
        model: e.model ?? "claude-opus-4-8",
        usage: {
          input_tokens: e.input ?? 0,
          output_tokens: e.output ?? 0,
          cache_creation_input_tokens: e.cacheCreation ?? 0,
          cache_read_input_tokens: e.cacheRead ?? 0,
        },
      },
    }),
  );
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

/**
 * Estimate with the Claude Code settings lookup pinned (null = disabled), so
 * tests are deterministic regardless of the machine's real ~/.claude/settings.json.
 */
function est(
  transcriptPath: string,
  claudeSettingsModel: string | null = null,
) {
  return estimateContextUsage(transcriptPath, { claudeSettingsModel });
}

describe("estimateContextUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    // Clear env overrides
    delete process.env.SENTINAL_BYTES_PER_TOKEN;
    delete process.env.SENTINAL_CONTEXT_WINDOW;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SENTINAL_BYTES_PER_TOKEN;
    delete process.env.SENTINAL_CONTEXT_WINDOW;
  });

  it("should return 0% for missing file", () => {
    const result = est("/nonexistent/file.txt");
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.fileBytes).toBe(0);
  });

  it("should return 0% for empty file", () => {
    const filePath = join(tmpDir, "empty.txt");
    writeFileSync(filePath, "");
    const result = est(filePath);
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.fileBytes).toBe(0);
  });

  it("should estimate percentage for a known file size (file-size fallback)", () => {
    // 300,000 bytes / 3 bytes per token = 100,000 tokens
    // 100,000 / 200,000 = 50% raw → 50% / 0.835 = ~60% effective
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = est(filePath);
    expect(result.fileBytes).toBe(300_000);
    expect(result.tokens).toBe(100_000);
    expect(result.percent).toBe(60);
    expect(result.source).toBe("file-size-estimate");
  });

  it("should cap at 100%", () => {
    // 600,000 bytes / 3 = 200,000 tokens = 100% raw → capped
    const filePath = join(tmpDir, "full.txt");
    writeFileSync(filePath, "x".repeat(600_000));

    const result = est(filePath);
    expect(result.percent).toBe(100);
  });

  it("should respect SENTINAL_BYTES_PER_TOKEN env var", () => {
    process.env.SENTINAL_BYTES_PER_TOKEN = "6";
    // 300,000 bytes / 6 = 50,000 tokens; 50,000 / 200,000 = 25% raw → ~30%
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = est(filePath);
    expect(result.tokens).toBe(50_000);
    expect(result.percent).toBe(30);
  });

  it("should respect SENTINAL_CONTEXT_WINDOW env var", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "100000";
    // 300,000 bytes / 3 = 100,000 tokens; 100,000 / 100,000 = 100% raw → capped
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = est(filePath);
    expect(result.percent).toBe(100);
  });

  it("should ignore invalid env values", () => {
    process.env.SENTINAL_BYTES_PER_TOKEN = "not-a-number";
    process.env.SENTINAL_CONTEXT_WINDOW = "-5";

    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = est(filePath);
    // Falls back to defaults: 300,000 / 3 = 100,000; 100,000/200,000 = 50% → 60%
    expect(result.percent).toBe(60);
  });
});

describe("estimateContextUsage — real token usage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sentinal-ctx-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    delete process.env.SENTINAL_BYTES_PER_TOKEN;
    delete process.env.SENTINAL_CONTEXT_WINDOW;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SENTINAL_BYTES_PER_TOKEN;
    delete process.env.SENTINAL_CONTEXT_WINDOW;
  });

  it("uses real tokens (input + cache creation + cache read), excluding output", () => {
    const p = writeTranscript(tmpDir, "single.jsonl", [
      { input: 1000, cacheCreation: 2000, cacheRead: 100_000, output: 5000 },
    ]);
    const r = est(p);
    expect(r.source).toBe("transcript-usage");
    expect(r.tokens).toBe(103_000); // output excluded
    expect(r.contextWindow).toBe(200_000);
    // raw 51.5% → /0.835 → 62%
    expect(r.percent).toBe(62);
  });

  it("uses the most recent assistant message", () => {
    const p = writeTranscript(tmpDir, "multi.jsonl", [
      { input: 100, cacheRead: 10_000 },
      { type: "user" },
      { input: 200, cacheRead: 50_000 },
    ]);
    const r = est(p);
    expect(r.tokens).toBe(50_200);
  });

  it("auto-detects the 1M window from live evidence when usage exceeds 200k", () => {
    const p = writeTranscript(tmpDir, "big.jsonl", [
      { input: 10_000, cacheRead: 300_000 },
    ]);
    const r = est(p);
    expect(r.contextWindow).toBe(1_000_000);
    // 310,000 / 1,000,000 = 31% raw → /0.835 → 37% (NOT 100%)
    expect(r.percent).toBe(37);
  });

  it("infers the 1M window from the Claude Code settings model tier marker", () => {
    const p = writeTranscript(tmpDir, "tier.jsonl", [
      { input: 1000, cacheCreation: 2000, cacheRead: 100_000 },
    ]);
    const r = estimateContextUsage(p, { claudeSettingsModel: "opus[1m]" });
    expect(r.contextWindow).toBe(1_000_000);
    // 103,000 / 1,000,000 = 10.3% raw → /0.835 → 12%
    expect(r.percent).toBe(12);
  });

  it("uses the standard window when the settings model has no tier marker", () => {
    const p = writeTranscript(tmpDir, "std.jsonl", [
      { input: 1000, cacheCreation: 2000, cacheRead: 100_000 },
    ]);
    const r = estimateContextUsage(p, { claudeSettingsModel: "opus" });
    expect(r.contextWindow).toBe(200_000);
    expect(r.percent).toBe(62);
  });

  it("respects SENTINAL_CONTEXT_WINDOW override on the token path", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "1000000";
    const p = writeTranscript(tmpDir, "override.jsonl", [
      { input: 1000, cacheCreation: 2000, cacheRead: 100_000 },
    ]);
    const r = est(p);
    expect(r.contextWindow).toBe(1_000_000);
    // 103,000 / 1,000,000 = 10.3% raw → /0.835 → 12%
    expect(r.percent).toBe(12);
  });

  it("reports a low percentage for a mid-size real context on a 1M window", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "1000000";
    // ~109k real tokens — the scenario that previously mis-reported ~92%.
    const p = writeTranscript(tmpDir, "live.jsonl", [
      { input: 2, cacheCreation: 2649, cacheRead: 106_323, output: 696 },
    ]);
    const r = est(p);
    expect(r.tokens).toBe(108_974);
    expect(r.percent).toBeLessThan(20);
  });

  it("falls back to file-size estimate when no assistant usage is present", () => {
    const p = join(tmpDir, "plain.txt");
    writeFileSync(p, "x".repeat(300_000));
    const r = est(p);
    expect(r.source).toBe("file-size-estimate");
    expect(r.tokens).toBe(100_000);
    expect(r.percent).toBe(60);
  });
});
