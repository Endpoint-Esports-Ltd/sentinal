/**
 * Context Window Resolution
 *
 * Determines the context-window size (the denominator for usage %) for the
 * current model/runtime, inferring it from real signals instead of relying on
 * a blunt env default. No single signal is universal, so resolution is layered:
 *
 *   1. SENTINAL_CONTEXT_WINDOW env override — explicit, absolute
 *   2. Large-context tier marker on the runtime model id (e.g. "…-1m")
 *   3. Claude Code: the settings.json `model` tier marker (e.g. "opus[1m]") —
 *      the transcript only records the bare model id, which can't disambiguate
 *      the 200k vs 1M tier, but settings.json can
 *   4. Static model→window table (covers Claude / OpenAI / Gemini / …)
 *   5. Live evidence — the model can't receive more tokens than its window, so
 *      observed usage above the inferred window means a larger tier is in play
 *   6. Conservative 200k default
 *
 * `resolveContextWindow` is pure (no filesystem) so it is fully testable; the
 * Claude Code settings read lives in the injectable `readClaudeCodeModel`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "../utils/shell.js";

// --- Constants ---

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LARGE_CONTEXT_WINDOW = 1_000_000;

/** Ascending ladder of standard context-window tiers, used by live evidence. */
const TIER_LADDER = [200_000, 1_000_000, 2_000_000];

/**
 * Static model→window table. Values are each model's maximum context window in
 * tokens, matched by substring against the (lower-cased) model id. Maintained
 * alongside the PRICING table in usage-stats.ts. Anthropic's standard tier is
 * 200k; its 1M tier is signalled separately by a tier marker (see
 * detectTierWindow), not by the bare model id.
 */
const MODEL_WINDOWS: Array<{ match: string; window: number }> = [
  // Anthropic (standard tier; 1M tier detected via marker)
  { match: "claude", window: 200_000 },
  // Google Gemini
  { match: "gemini-1.5-pro", window: 2_000_000 },
  { match: "gemini", window: 1_000_000 },
  // OpenAI
  { match: "gpt-4.1", window: 1_000_000 },
  { match: "gpt-4o", window: 128_000 },
  { match: "gpt-4-turbo", window: 128_000 },
  { match: "o1", window: 200_000 },
  { match: "o3", window: 200_000 },
  { match: "o4", window: 200_000 },
  // Others
  { match: "llama", window: 128_000 },
  { match: "mistral", window: 128_000 },
  { match: "deepseek", window: 128_000 },
  { match: "grok", window: 128_000 },
];

// --- Types ---

export interface WindowHints {
  /** Real context tokens observed so far (input + cache). Enables live evidence. */
  observedTokens?: number;
  /** Runtime model id (transcript `message.model` / OpenCode `modelID`). */
  modelId?: string | null;
  /** OpenCode provider id, when known. */
  providerId?: string | null;
  /** Claude Code settings.json `model` value (carries the tier marker). */
  settingsModel?: string | null;
  /** Which runtime we're resolving for. Gates the settings.json lookup. */
  runtime?: "claude-code" | "opencode";
}

// --- Public API ---

/**
 * Detect a large-context tier marker on a model string (e.g. "opus[1m]",
 * "claude-sonnet-4-6-1m", "anthropic/claude:1m"). Returns the large window, or
 * null when no marker is present.
 */
export function detectTierWindow(
  model: string | null | undefined,
): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (
    m.includes("[1m]") ||
    m.includes("-1m") ||
    m.includes(":1m") ||
    m.includes("1m-context")
  ) {
    return LARGE_CONTEXT_WINDOW;
  }
  return null;
}

/**
 * Look up a model's context window from the static table by substring match.
 * Returns null for unknown models.
 */
export function contextWindowForModel(
  modelId: string | null | undefined,
): number | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  for (const rule of MODEL_WINDOWS) {
    if (m.includes(rule.match)) return rule.window;
  }
  return null;
}

/** Smallest standard tier ≥ tokens; rounds up to 500k beyond the known ladder. */
export function smallestTierAtLeast(tokens: number): number {
  for (const tier of TIER_LADDER) {
    if (tier >= tokens) return tier;
  }
  return Math.ceil(tokens / 500_000) * 500_000;
}

/**
 * Resolve the context window to use as the usage denominator. Pure — all
 * filesystem-derived input (settingsModel) must be passed in by the caller.
 */
export function resolveContextWindow(hints: WindowHints = {}): number {
  // 1. Explicit override wins outright.
  const envWindow = getEnvInt("SENTINAL_CONTEXT_WINDOW", 0);
  if (envWindow > 0) return envWindow;

  // 2-4. Infer from model / tier marker / settings.
  const inferred = inferWindow(hints);
  const base = inferred ?? DEFAULT_CONTEXT_WINDOW;

  // 5. Live evidence: a window can't be smaller than the tokens already sent.
  const observed = hints.observedTokens ?? 0;
  if (observed > base) return smallestTierAtLeast(observed);

  return base;
}

/**
 * Read Claude Code's configured model string.
 * Prefers the ANTHROPIC_MODEL env var, then the `model` field in
 * ~/.claude/settings.json (override the path for tests). Returns null if none.
 */
export function readClaudeCodeModel(
  settingsPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envModel = env.ANTHROPIC_MODEL;
  if (envModel && envModel.trim()) return envModel.trim();

  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const settings = JSON.parse(stripJsoncComments(raw)) as Record<
      string,
      unknown
    >;
    return typeof settings.model === "string" ? settings.model : null;
  } catch {
    return null;
  }
}

// --- Internal ---

function inferWindow(hints: WindowHints): number | null {
  // Tier marker on the runtime model id (e.g. an OpenCode "…-1m" variant).
  const tier = detectTierWindow(hints.modelId);
  if (tier) return tier;

  // Claude Code: the settings.json model carries the tier the transcript lacks.
  const useSettings = hints.runtime !== "opencode" && !!hints.settingsModel;
  if (useSettings) {
    const settingsTier = detectTierWindow(hints.settingsModel);
    if (settingsTier) return settingsTier;
  }

  // Static table by runtime model id.
  const byModel = contextWindowForModel(hints.modelId);
  if (byModel) return byModel;

  // Static table by settings model (Claude Code last resort).
  if (useSettings) {
    const bySettings = contextWindowForModel(hints.settingsModel);
    if (bySettings) return bySettings;
  }

  return null;
}

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
