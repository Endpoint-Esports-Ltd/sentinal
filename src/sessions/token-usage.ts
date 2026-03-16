/**
 * Token Usage Aggregation
 *
 * Aggregates token usage from OpenCode SDK session messages into
 * a ContextUsage-compatible format for context monitoring.
 *
 * OpenCode exposes actual token counts per assistant message via its SDK,
 * which is more accurate than Claude Code's file-size-based estimation.
 *
 * Configurable via environment variables:
 *   SENTINAL_CONTEXT_WINDOW — context window size in tokens (default: 200000)
 */

import type { ContextUsage } from "./context.js";

// --- Types ---

/** Token counts from a single OpenCode assistant message. */
export interface MessageTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/** A session message as returned by OpenCode's SDK. */
export interface SessionMessage {
  info: {
    role: string;
    tokens?: MessageTokens;
  };
}

// --- Constants ---

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Minimum number of tool calls between context checks.
 * Prevents hammering the session API on every tool execution.
 */
export const CONTEXT_CHECK_INTERVAL = 5;

// --- Public API ---

/**
 * Aggregate token usage from OpenCode session messages into a ContextUsage.
 *
 * Context usage is based on cumulative input tokens (including cache reads),
 * since that's what fills the context window. Output tokens are the model's
 * response and don't consume context window space the same way.
 *
 * The most recent assistant message's input + cache.read gives the best
 * approximation of current context window usage, since each API call sends
 * the full conversation context.
 */
export function aggregateTokenUsage(messages: SessionMessage[]): ContextUsage {
  const contextWindow = getEnvInt(
    "SENTINAL_CONTEXT_WINDOW",
    DEFAULT_CONTEXT_WINDOW,
  );

  // Find the most recent assistant message with token data.
  // Its input + cache.read represents the current context window fill level.
  let latestTokens: MessageTokens | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "assistant" && msg.info.tokens) {
      latestTokens = msg.info.tokens;
      break;
    }
  }

  if (!latestTokens) {
    return { percent: 0, tokens: 0, fileBytes: 0 };
  }

  // Current context = input tokens + cache reads (both represent context sent to model)
  const contextTokens = latestTokens.input + latestTokens.cache.read;
  const percent = Math.min(
    100,
    Math.round((contextTokens / contextWindow) * 100),
  );

  return {
    percent,
    tokens: contextTokens,
    fileBytes: 0, // Not applicable for SDK-based estimation
  };
}

// --- Helpers ---

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
