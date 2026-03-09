import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateContextUsage } from "./context.js";

describe("estimateContextUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sentinal-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    const result = estimateContextUsage("/nonexistent/file.txt");
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.fileBytes).toBe(0);
  });

  it("should return 0% for empty file", () => {
    const filePath = join(tmpDir, "empty.txt");
    writeFileSync(filePath, "");
    const result = estimateContextUsage(filePath);
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.fileBytes).toBe(0);
  });

  it("should estimate percentage for a known file size", () => {
    // 300,000 bytes / 3 bytes per token = 100,000 tokens
    // 100,000 / 200,000 = 50% raw
    // 50% / 0.835 = ~59.88% → 60% effective
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = estimateContextUsage(filePath);
    expect(result.fileBytes).toBe(300_000);
    expect(result.tokens).toBe(100_000);
    expect(result.percent).toBe(60);
  });

  it("should cap at 100%", () => {
    // 600,000 bytes / 3 = 200,000 tokens = 100% raw
    // 100% / 0.835 = ~119.76% → capped at 100%
    const filePath = join(tmpDir, "full.txt");
    writeFileSync(filePath, "x".repeat(600_000));

    const result = estimateContextUsage(filePath);
    expect(result.percent).toBe(100);
  });

  it("should respect SENTINAL_BYTES_PER_TOKEN env var", () => {
    process.env.SENTINAL_BYTES_PER_TOKEN = "6";
    // 300,000 bytes / 6 = 50,000 tokens
    // 50,000 / 200,000 = 25% raw
    // 25% / 0.835 = ~29.94% → 30%
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = estimateContextUsage(filePath);
    expect(result.tokens).toBe(50_000);
    expect(result.percent).toBe(30);
  });

  it("should respect SENTINAL_CONTEXT_WINDOW env var", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "100000";
    // 300,000 bytes / 3 = 100,000 tokens
    // 100,000 / 100,000 = 100% raw
    // 100% / 0.835 = ~119.76% → capped at 100%
    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = estimateContextUsage(filePath);
    expect(result.percent).toBe(100);
  });

  it("should ignore invalid env values", () => {
    process.env.SENTINAL_BYTES_PER_TOKEN = "not-a-number";
    process.env.SENTINAL_CONTEXT_WINDOW = "-5";

    const filePath = join(tmpDir, "transcript.txt");
    writeFileSync(filePath, "x".repeat(300_000));

    const result = estimateContextUsage(filePath);
    // Falls back to defaults: 300,000 / 3 = 100,000; 100,000/200,000 = 50%; 50%/0.835 = 60%
    expect(result.percent).toBe(60);
  });
});
