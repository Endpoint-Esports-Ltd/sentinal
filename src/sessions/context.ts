/**
 * Context Usage Estimation
 *
 * Estimates AI assistant context-window usage for the Claude Code context
 * monitor.
 *
 * Prefers the REAL token counts Claude Code records in the transcript (the
 * `usage` block on each assistant message) and only falls back to a coarse
 * file-size heuristic when no usage data is available yet. The previous
 * implementation derived usage purely from transcript file size, which
 * over-reported wildly (a ~460KB transcript read as ~92% on a 200k window
 * even though the live context was ~10% of a 1M window).
 *
 * The context-window denominator is resolved by `resolveContextWindow`
 * (see context-window.ts): env override → model tier marker → Claude Code
 * settings.json model → static model table → live evidence → 200k default.
 *
 * The effective percentage accounts for Claude Code's compaction buffer
 * (~16.5%): effective = raw / 0.835, capped at 100%. "100% effective" marks
 * the point where auto-compaction fires, not a literally full window.
 *
 * Configurable via environment variables:
 *   SENTINAL_CONTEXT_WINDOW   — context window size in tokens (override)
 *   SENTINAL_BYTES_PER_TOKEN  — bytes per token, file-size fallback (default: 3)
 */

import { statSync } from "node:fs";
import { parseJsonlLogs, type LogEntry } from "./usage-stats.js";
import { resolveContextWindow, readClaudeCodeModel } from "./context-window.js";

// --- Constants ---

const DEFAULT_BYTES_PER_TOKEN = 3;
const COMPACTION_BUFFER = 0.835;

// --- Public API ---

export type ContextSource = "transcript-usage" | "file-size-estimate";

export interface ContextUsage {
  /** Effective context usage percentage (0-100), accounting for compaction buffer. */
  percent: number;
  /** Context token count — real when source is "transcript-usage", estimated otherwise. */
  tokens: number;
  /** Raw transcript file size in bytes (0 when token-based). */
  fileBytes: number;
  /** Context window size (tokens) used as the denominator. */
  contextWindow?: number;
  /** Where the token figure came from. */
  source?: ContextSource;
}

export interface EstimateOptions {
  /**
   * Override the Claude Code settings `model` string used for window inference.
   * `undefined` (default) reads ~/.claude/settings.json; `null` disables the
   * lookup; a string forces a specific value. Mainly for tests / non-CC callers.
   */
  claudeSettingsModel?: string | null;
}

/**
 * Estimate context-window usage for a transcript.
 *
 * Returns the most accurate figure available: real token usage from the
 * transcript when present, otherwise a coarse file-size estimate. Returns 0%
 * for missing/empty/unreadable transcripts (graceful degradation).
 */
export function estimateContextUsage(
  transcriptPath: string,
  opts: EstimateOptions = {},
): ContextUsage {
  const entries = safeParse(transcriptPath);
  const modelId = latestModel(entries);
  const settingsModel =
    opts.claudeSettingsModel !== undefined
      ? opts.claudeSettingsModel
      : readClaudeCodeModel();

  // Preferred path: real token usage from the transcript's latest message.
  const liveTokens = latestContextTokens(entries);
  if (liveTokens !== null) {
    const contextWindow = resolveContextWindow({
      observedTokens: liveTokens,
      modelId,
      settingsModel,
      runtime: "claude-code",
    });
    return {
      percent: toEffectivePercent(liveTokens, contextWindow),
      tokens: liveTokens,
      fileBytes: 0,
      contextWindow,
      source: "transcript-usage",
    };
  }

  // Fallback: coarse file-size estimate (no usage data in the transcript yet).
  const contextWindow = resolveContextWindow({
    modelId,
    settingsModel,
    runtime: "claude-code",
  });
  const bytesPerToken = getEnvInt(
    "SENTINAL_BYTES_PER_TOKEN",
    DEFAULT_BYTES_PER_TOKEN,
  );

  let fileBytes = 0;
  try {
    fileBytes = statSync(transcriptPath).size;
  } catch {
    return {
      percent: 0,
      tokens: 0,
      fileBytes: 0,
      contextWindow,
      source: "file-size-estimate",
    };
  }

  const tokens = Math.round(fileBytes / bytesPerToken);
  return {
    percent: toEffectivePercent(tokens, contextWindow),
    tokens,
    fileBytes,
    contextWindow,
    source: "file-size-estimate",
  };
}

// --- Helpers ---

/** Parse a transcript into log entries, never throwing. */
function safeParse(transcriptPath: string): LogEntry[] {
  try {
    return parseJsonlLogs(transcriptPath);
  } catch {
    return [];
  }
}

/**
 * Current context-window fill from the most recent assistant message.
 *
 * Each Claude Code API call resends the full conversation, so the latest
 * message's input + cache tokens is the real live context size. Output tokens
 * are the model's response and are NOT counted — they don't occupy the input
 * context window. Returns null when there is no parseable usage yet.
 */
function latestContextTokens(entries: LogEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const contextTokens =
      e.inputTokens + e.cacheCreationTokens + e.cacheReadTokens;
    if (contextTokens > 0) return contextTokens;
  }
  return null;
}

/** Model id from the most recent assistant entry, or null. */
function latestModel(entries: LogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const model = entries[i].model;
    if (model && model !== "unknown") return model;
  }
  return null;
}

/**
 * Convert a token count into an effective percentage, rescaled for the
 * compaction buffer and capped at 100%.
 */
function toEffectivePercent(tokens: number, contextWindow: number): number {
  const rawPercent = (tokens / contextWindow) * 100;
  return Math.min(100, Math.round(rawPercent / COMPACTION_BUFFER));
}

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
