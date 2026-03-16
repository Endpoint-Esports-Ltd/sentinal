/**
 * Context Usage Estimation
 *
 * Estimates AI assistant context window usage from transcript file size.
 * Replaces the broken `~/.legacy/bin/legacy check-context --json` dependency.
 *
 * Configurable via environment variables:
 *   SENTINAL_BYTES_PER_TOKEN  — bytes per token estimate (default: 3)
 *   SENTINAL_CONTEXT_WINDOW   — context window size in tokens (default: 200000)
 *
 * The effective percentage accounts for Claude Code's compaction buffer (~16.5%).
 * Raw usage is rescaled: effective = raw / 0.835, capped at 100%.
 */

import { statSync } from "node:fs";

// --- Constants ---

const DEFAULT_BYTES_PER_TOKEN = 3;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const COMPACTION_BUFFER = 0.835;

// --- Public API ---

export interface ContextUsage {
  /** Effective context usage percentage (0-100), accounting for compaction buffer. */
  percent: number;
  /** Estimated token count. */
  tokens: number;
  /** Raw transcript file size in bytes. */
  fileBytes: number;
}

/**
 * Estimate context window usage from a transcript file.
 * Returns 0% for missing/empty files (graceful degradation).
 */
export function estimateContextUsage(transcriptPath: string): ContextUsage {
  const bytesPerToken = getEnvInt(
    "SENTINAL_BYTES_PER_TOKEN",
    DEFAULT_BYTES_PER_TOKEN,
  );
  const contextWindow = getEnvInt(
    "SENTINAL_CONTEXT_WINDOW",
    DEFAULT_CONTEXT_WINDOW,
  );

  let fileBytes = 0;
  try {
    fileBytes = statSync(transcriptPath).size;
  } catch {
    return { percent: 0, tokens: 0, fileBytes: 0 };
  }

  const tokens = Math.round(fileBytes / bytesPerToken);
  const rawPercent = (tokens / contextWindow) * 100;
  const effective = Math.min(100, Math.round(rawPercent / COMPACTION_BUFFER));

  return { percent: effective, tokens, fileBytes };
}

// --- Helpers ---

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
