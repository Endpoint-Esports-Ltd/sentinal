import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveContextWindow,
  contextWindowForModel,
  detectTierWindow,
  smallestTierAtLeast,
  readClaudeCodeModel,
  DEFAULT_CONTEXT_WINDOW,
  LARGE_CONTEXT_WINDOW,
} from "./context-window";

describe("detectTierWindow", () => {
  it("detects large-context tier markers", () => {
    expect(detectTierWindow("opus[1m]")).toBe(LARGE_CONTEXT_WINDOW);
    expect(detectTierWindow("claude-sonnet-4-6-1m")).toBe(LARGE_CONTEXT_WINDOW);
    expect(detectTierWindow("anthropic/claude:1m")).toBe(LARGE_CONTEXT_WINDOW);
  });
  it("returns null without a marker", () => {
    expect(detectTierWindow("claude-opus-4-8")).toBeNull();
    expect(detectTierWindow(null)).toBeNull();
    expect(detectTierWindow(undefined)).toBeNull();
  });
});

describe("contextWindowForModel", () => {
  it("maps Claude models to the standard 200k window", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowForModel("claude-3-5-sonnet-20241022")).toBe(200_000);
  });
  it("maps known large-window models", () => {
    expect(contextWindowForModel("gemini-2.0-flash")).toBe(1_000_000);
    expect(contextWindowForModel("gpt-4o")).toBe(128_000);
  });
  it("returns null for unknown models", () => {
    expect(contextWindowForModel("some-unknown-model")).toBeNull();
    expect(contextWindowForModel(null)).toBeNull();
  });
});

describe("smallestTierAtLeast", () => {
  it("picks the smallest standard tier >= tokens", () => {
    expect(smallestTierAtLeast(150_000)).toBe(200_000);
    expect(smallestTierAtLeast(250_000)).toBe(1_000_000);
    expect(smallestTierAtLeast(1_500_000)).toBe(2_000_000);
  });
  it("rounds up beyond the known ladder", () => {
    expect(smallestTierAtLeast(2_400_000)).toBe(2_500_000);
  });
});

describe("resolveContextWindow", () => {
  const orig = process.env.SENTINAL_CONTEXT_WINDOW;
  afterEach(() => {
    if (orig !== undefined) process.env.SENTINAL_CONTEXT_WINDOW = orig;
    else delete process.env.SENTINAL_CONTEXT_WINDOW;
  });

  it("honors the env override above all else", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "500000";
    expect(resolveContextWindow({ modelId: "claude-opus-4-8" })).toBe(500_000);
  });

  it("uses the settings.json tier marker for Claude Code", () => {
    delete process.env.SENTINAL_CONTEXT_WINDOW;
    expect(
      resolveContextWindow({
        modelId: "claude-opus-4-8",
        settingsModel: "opus[1m]",
        runtime: "claude-code",
      }),
    ).toBe(LARGE_CONTEXT_WINDOW);
  });

  it("falls back to the model table when no tier marker", () => {
    delete process.env.SENTINAL_CONTEXT_WINDOW;
    expect(
      resolveContextWindow({
        modelId: "claude-opus-4-8",
        settingsModel: "opus",
        runtime: "claude-code",
      }),
    ).toBe(200_000);
  });

  it("uses the model-id table for OpenCode without a settings lookup", () => {
    delete process.env.SENTINAL_CONTEXT_WINDOW;
    expect(
      resolveContextWindow({ modelId: "gpt-4o", runtime: "opencode" }),
    ).toBe(128_000);
    expect(
      resolveContextWindow({
        modelId: "gemini-2.0-flash",
        runtime: "opencode",
      }),
    ).toBe(1_000_000);
  });

  it("bumps the window when observed usage exceeds the inferred window", () => {
    delete process.env.SENTINAL_CONTEXT_WINDOW;
    // opus standard is 200k, but 260k has already been observed ⇒ must be 1M tier
    expect(
      resolveContextWindow({
        modelId: "claude-opus-4-8",
        observedTokens: 260_000,
      }),
    ).toBe(LARGE_CONTEXT_WINDOW);
  });

  it("does NOT let live evidence override an explicit env window", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "200000";
    expect(
      resolveContextWindow({
        modelId: "claude-opus-4-8",
        observedTokens: 260_000,
      }),
    ).toBe(200_000);
  });

  it("defaults to 200k for unknown models with no other signal", () => {
    delete process.env.SENTINAL_CONTEXT_WINDOW;
    expect(resolveContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("readClaudeCodeModel", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(
      tmpdir(),
      `sentinal-ccmodel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    delete process.env.ANTHROPIC_MODEL;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_MODEL;
  });

  it("reads the model field from settings.json", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ model: "opus[1m]" }));
    expect(readClaudeCodeModel(p)).toBe("opus[1m]");
  });

  it("tolerates JSONC comments in settings.json", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, '{\n  // model tier\n  "model": "sonnet[1m]"\n}');
    expect(readClaudeCodeModel(p)).toBe("sonnet[1m]");
  });

  it("prefers ANTHROPIC_MODEL env when set", () => {
    process.env.ANTHROPIC_MODEL = "sonnet[1m]";
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ model: "opus" }));
    expect(readClaudeCodeModel(p)).toBe("sonnet[1m]");
  });

  it("returns null when the settings file is missing or has no model", () => {
    expect(readClaudeCodeModel(join(dir, "nope.json"))).toBeNull();
    const p = join(dir, "empty.json");
    writeFileSync(p, JSON.stringify({}));
    expect(readClaudeCodeModel(p)).toBeNull();
  });
});
