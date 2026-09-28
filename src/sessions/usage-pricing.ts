/**
 * Usage types, plan limits, pricing and cost aggregation for the Claude Code
 * usage stats (`usage-stats.ts`, which re-exports the public types and
 * constants). Split out of `usage-stats.ts` for length.
 */

// --- Types ---

export interface LogEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestamp: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costEquiv: number;
  pctOfLimit: number;
  oldestTimestamp: string | null;
  resetsIn: number; // ms until oldest entry ages out of rolling window
}

export interface SessionUsage {
  byModel: Record<string, ModelUsage>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostEquiv: number;
  pctOfLimit: number;
}

export interface DailyUsageEntry {
  date: string;
  byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; costEquiv: number }
  >;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostEquiv: number;
}

export interface UsageSummary {
  byModel: Record<string, ModelUsage>;
  totalCostEquiv: number;
  pctOfLimit: number;
  planTier: string;
  weeklyResetsIn: number;
}

export type PlanTier = "max_5x" | "max_20x";

// --- Constants ---

// API-cost-equivalent weekly limits in USD
// These are estimates of the API-equivalent value provided by each plan tier,
// NOT the subscription cost. Max 5x subscription is $100/mo but provides
// significantly more in API-equivalent usage.
export const PLAN_LIMITS: Record<PlanTier, number> = {
  max_5x: 200,
  max_20x: 800,
};

// Anthropic pricing (USD per million tokens) — as of 2025
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5-20251001": {
    input: 0.8,
    output: 4,
    cacheWrite: 1,
    cacheRead: 0.08,
  },
};

// Default pricing for unknown models (use Sonnet pricing as baseline)
const DEFAULT_PRICING = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

// Models to display in the statusline (exclude background/internal models)
export const DISPLAY_MODELS = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);

// Rolling window for weekly usage (7 days in ms)
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Rolling window for session/short-term rate limit (5 hours in ms)
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

// API-cost-equivalent 4-hour session limits in USD (estimates)
export const SESSION_LIMITS: Record<PlanTier, number> = {
  max_5x: 30,
  max_20x: 120,
};

// --- Cost ---

export function calculateCost(entry: LogEntry): number {
  const pricing = PRICING[entry.model] || DEFAULT_PRICING;
  return (
    (entry.inputTokens * pricing.input) / 1_000_000 +
    (entry.outputTokens * pricing.output) / 1_000_000 +
    (entry.cacheCreationTokens * pricing.cacheWrite) / 1_000_000 +
    (entry.cacheReadTokens * pricing.cacheRead) / 1_000_000
  );
}

export function aggregateEntries(
  entries: LogEntry[],
  planTier: PlanTier,
): {
  byModel: Record<string, ModelUsage>;
  totalCostEquiv: number;
  pctOfLimit: number;
} {
  const limit = PLAN_LIMITS[planTier];
  const byModel: Record<string, ModelUsage> = {};
  let totalCost = 0;

  for (const entry of entries) {
    if (!byModel[entry.model]) {
      byModel[entry.model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costEquiv: 0,
        pctOfLimit: 0,
        oldestTimestamp: null,
        resetsIn: 0,
      };
    }

    const m = byModel[entry.model];
    m.inputTokens += entry.inputTokens;
    m.outputTokens += entry.outputTokens;
    m.cacheCreationTokens += entry.cacheCreationTokens;
    m.cacheReadTokens += entry.cacheReadTokens;

    const cost = calculateCost(entry);
    m.costEquiv += cost;
    totalCost += cost;

    if (!m.oldestTimestamp || entry.timestamp < m.oldestTimestamp) {
      m.oldestTimestamp = entry.timestamp;
    }
  }

  // Calculate percentages and reset countdowns
  const now = Date.now();
  for (const model of Object.keys(byModel)) {
    const m = byModel[model];
    m.pctOfLimit = Math.min(100, Math.round((m.costEquiv / limit) * 100));
    if (m.oldestTimestamp) {
      m.resetsIn = Math.max(
        0,
        new Date(m.oldestTimestamp).getTime() + WEEKLY_WINDOW_MS - now,
      );
    }
  }

  const pctOfLimit = Math.min(100, Math.round((totalCost / limit) * 100));

  return { byModel, totalCostEquiv: totalCost, pctOfLimit };
}
