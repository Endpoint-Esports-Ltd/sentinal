/**
 * Token Usage Aggregation Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  aggregateTokenUsage,
  type SessionMessage,
  CONTEXT_CHECK_INTERVAL,
} from "./token-usage";

function makeAssistantMsg(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
): SessionMessage {
  return {
    info: {
      role: "assistant",
      tokens: {
        input,
        output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
    },
  };
}

function makeUserMsg(): SessionMessage {
  return { info: { role: "user" } };
}

describe("aggregateTokenUsage", () => {
  const origContextWindow = process.env.SENTINAL_CONTEXT_WINDOW;

  afterEach(() => {
    if (origContextWindow !== undefined) {
      process.env.SENTINAL_CONTEXT_WINDOW = origContextWindow;
    } else {
      delete process.env.SENTINAL_CONTEXT_WINDOW;
    }
  });

  it("should return 0% for empty message array", () => {
    const result = aggregateTokenUsage([]);
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
  });

  it("should return 0% for messages with no assistant messages", () => {
    const result = aggregateTokenUsage([makeUserMsg(), makeUserMsg()]);
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
  });

  it("should return 0% for assistant messages without token data", () => {
    const msg: SessionMessage = { info: { role: "assistant" } };
    const result = aggregateTokenUsage([msg]);
    expect(result.percent).toBe(0);
    expect(result.tokens).toBe(0);
  });

  it("should use the most recent assistant message for context estimation", () => {
    const messages = [
      makeUserMsg(),
      makeAssistantMsg(50_000, 1000), // older
      makeUserMsg(),
      makeAssistantMsg(100_000, 2000), // most recent — 100k input = 50%
    ];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(50);
    expect(result.tokens).toBe(100_000);
  });

  it("should include cache reads in context calculation", () => {
    // input: 2 fresh + cache.read: 99_998 = 100k total context tokens = 50%
    const messages = [makeAssistantMsg(2, 500, 99_998)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(50);
    expect(result.tokens).toBe(100_000);
  });

  it("should not count output tokens toward context usage", () => {
    // input: 50k, output: 150k — only input counts
    const messages = [makeAssistantMsg(50_000, 150_000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(25);
    expect(result.tokens).toBe(50_000);
  });

  it("should not count reasoning tokens toward context usage", () => {
    // input: 40k, output: 5k, cache.read: 0, cache.write: 0, reasoning: 100k
    const messages = [makeAssistantMsg(40_000, 5000, 0, 0, 100_000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(20);
    expect(result.tokens).toBe(40_000);
  });

  it("should cap at 100%", () => {
    const messages = [makeAssistantMsg(250_000, 1000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(100);
  });

  it("should warn at 80% threshold", () => {
    // 160k / 200k = 80%
    const messages = [makeAssistantMsg(160_000, 1000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(80);
  });

  it("should respect SENTINAL_CONTEXT_WINDOW env var", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "100000";
    // 50k / 100k = 50%
    const messages = [makeAssistantMsg(50_000, 1000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(50);
  });

  it("should ignore invalid SENTINAL_CONTEXT_WINDOW values", () => {
    process.env.SENTINAL_CONTEXT_WINDOW = "not-a-number";
    // Falls back to 200k default: 100k / 200k = 50%
    const messages = [makeAssistantMsg(100_000, 1000)];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(50);
  });

  it("should skip non-assistant messages when looking for latest tokens", () => {
    const messages = [
      makeAssistantMsg(160_000, 2000), // has tokens
      makeUserMsg(), // user message after — should still find the assistant one
    ];
    const result = aggregateTokenUsage(messages);
    expect(result.percent).toBe(80);
    expect(result.tokens).toBe(160_000);
  });

  it("should set fileBytes to 0 (not applicable for SDK-based estimation)", () => {
    const messages = [makeAssistantMsg(100_000, 1000)];
    const result = aggregateTokenUsage(messages);
    expect(result.fileBytes).toBe(0);
  });
});

describe("CONTEXT_CHECK_INTERVAL", () => {
  it("should be a reasonable throttle value", () => {
    expect(CONTEXT_CHECK_INTERVAL).toBeGreaterThanOrEqual(3);
    expect(CONTEXT_CHECK_INTERVAL).toBeLessThanOrEqual(10);
  });
});
