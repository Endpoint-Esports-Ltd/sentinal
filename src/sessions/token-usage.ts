/**
 * Token Usage Aggregation
 *
 * Aggregates token usage from OpenCode SDK session messages into
 * a ContextUsage-compatible format for context monitoring.
 *
 * OpenCode exposes actual token counts per assistant message via its SDK,
 * which is more accurate than Claude Code's file-size-based estimation. The
 * message also carries the model/provider id, which `resolveContextWindow`
 * uses to pick the right context window per model instead of assuming 200k.
 *
 * Configurable via SENTINAL_CONTEXT_WINDOW (override; see context-window.ts).
 */

import type { ContextUsage } from "./context.js";
import { resolveContextWindow } from "./context-window.js";

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
    modelID?: string;
    providerID?: string;
    tokens?: MessageTokens;
  };
}

// --- Constants ---

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
 * the full conversation context. The window itself is resolved from that
 * message's model id (falling back to live evidence / default).
 */
export function aggregateTokenUsage(messages: SessionMessage[]): ContextUsage {
  // Find the most recent assistant message with token data.
  // Its input + cache.read represents the current context window fill level.
  let latest: SessionMessage["info"] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role === "assistant" && info.tokens) {
      latest = info;
      break;
    }
  }

  if (!latest || !latest.tokens) {
    return { percent: 0, tokens: 0, fileBytes: 0 };
  }

  // Current context = input tokens + cache reads (both represent context sent to model)
  const contextTokens = latest.tokens.input + latest.tokens.cache.read;
  const contextWindow = resolveContextWindow({
    observedTokens: contextTokens,
    modelId: latest.modelID ?? null,
    providerId: latest.providerID ?? null,
    runtime: "opencode",
  });
  const percent = Math.min(
    100,
    Math.round((contextTokens / contextWindow) * 100),
  );

  return {
    percent,
    tokens: contextTokens,
    fileBytes: 0, // Not applicable for SDK-based estimation
    contextWindow,
    source: "transcript-usage",
  };
}
