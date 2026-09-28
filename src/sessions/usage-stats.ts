/**
 * Usage Stats Module
 *
 * Parses Claude Code's JSONL conversation logs to calculate token usage
 * per model, with plan limit percentages and reset countdowns.
 *
 * JSONL log structure (assistant entries):
 *   { type: "assistant", timestamp, message: { model, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *
 * Logs location: ~/.claude/projects/<project-slug>/<session-id>.jsonl
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  SESSION_LIMITS,
  SESSION_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  aggregateEntries,
  calculateCost,
  type DailyUsageEntry,
  type LogEntry,
  type ModelUsage,
  type PlanTier,
  type SessionUsage,
  type UsageSummary,
} from "./usage-pricing.js";

// Types, limits and pricing live in usage-pricing.ts (split for length) and
// are re-exported so callers keep importing them from here.
export {
  DISPLAY_MODELS,
  PLAN_LIMITS,
  SESSION_LIMITS,
} from "./usage-pricing.js";
export type {
  DailyUsageEntry,
  LogEntry,
  ModelUsage,
  PlanTier,
  SessionUsage,
  UsageSummary,
} from "./usage-pricing.js";

// --- Cache ---

interface CacheEntry {
  data: LogEntry[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- Public API ---

/**
 * Parse a single JSONL log file into structured log entries.
 */
export function parseJsonlLogs(filePath: string): LogEntry[] {
  const cached = cache.get(filePath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const entries: LogEntry[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant" || !obj.message?.usage) continue;

      const msg = obj.message;
      const usage = msg.usage;

      entries.push({
        model: msg.model || "unknown",
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        timestamp: obj.timestamp || "",
      });
    } catch {
      // Skip malformed lines
    }
  }

  cache.set(filePath, { data: entries, timestamp: Date.now() });
  return entries;
}

/**
 * Get token usage summary for a single session transcript.
 */
export function getSessionUsage(
  transcriptPath: string,
  planTier: PlanTier = "max_5x",
): SessionUsage {
  const entries = parseJsonlLogs(transcriptPath);
  const { byModel, totalCostEquiv, pctOfLimit } = aggregateEntries(
    entries,
    planTier,
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const m of Object.values(byModel)) {
    totalInputTokens += m.inputTokens;
    totalOutputTokens += m.outputTokens;
  }

  return {
    byModel,
    totalInputTokens,
    totalOutputTokens,
    totalCostEquiv,
    pctOfLimit,
  };
}

/**
 * Get usage within the 4-hour rolling session window across all log files.
 * This represents the short-term rate limit window Claude Code uses.
 */
export function getSessionWindowUsage(
  logFiles: string[],
  planTier: PlanTier = "max_5x",
): UsageSummary {
  const now = Date.now();
  const windowStart = now - SESSION_WINDOW_MS;
  const allEntries: LogEntry[] = [];

  for (const file of logFiles) {
    const entries = parseJsonlLogs(file);
    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime >= windowStart) {
        allEntries.push(entry);
      }
    }
  }

  const limit = SESSION_LIMITS[planTier];
  const byModel: Record<string, ModelUsage> = {};
  let totalCost = 0;

  for (const entry of allEntries) {
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

  // Calculate percentages and reset countdowns against SESSION window
  for (const model of Object.keys(byModel)) {
    const m = byModel[model];
    m.pctOfLimit = Math.min(100, Math.round((m.costEquiv / limit) * 100));
    if (m.oldestTimestamp) {
      m.resetsIn = Math.max(
        0,
        new Date(m.oldestTimestamp).getTime() + SESSION_WINDOW_MS - now,
      );
    }
  }

  const pctOfLimit = Math.min(100, Math.round((totalCost / limit) * 100));

  let oldestTime = now;
  for (const entry of allEntries) {
    const t = new Date(entry.timestamp).getTime();
    if (t < oldestTime) oldestTime = t;
  }
  const weeklyResetsIn =
    allEntries.length > 0
      ? Math.max(0, oldestTime + SESSION_WINDOW_MS - now)
      : 0;

  return {
    byModel,
    totalCostEquiv: totalCost,
    pctOfLimit,
    planTier,
    weeklyResetsIn,
  };
}

/**
 * Get daily usage breakdown from multiple log files.
 */
export function getDailyUsage(logFiles: string[]): DailyUsageEntry[] {
  const byDate = new Map<string, LogEntry[]>();

  for (const file of logFiles) {
    const entries = parseJsonlLogs(file);
    for (const entry of entries) {
      const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
      if (!date) continue;
      const existing = byDate.get(date) || [];
      existing.push(entry);
      byDate.set(date, existing);
    }
  }

  const result: DailyUsageEntry[] = [];
  const sortedDates = [...byDate.keys()].sort();

  for (const date of sortedDates) {
    const entries = byDate.get(date)!;
    const byModel: Record<
      string,
      { inputTokens: number; outputTokens: number; costEquiv: number }
    > = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const entry of entries) {
      if (!byModel[entry.model]) {
        byModel[entry.model] = {
          inputTokens: 0,
          outputTokens: 0,
          costEquiv: 0,
        };
      }
      byModel[entry.model].inputTokens += entry.inputTokens;
      byModel[entry.model].outputTokens += entry.outputTokens;
      const cost = calculateCost(entry);
      byModel[entry.model].costEquiv += cost;
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      totalCost += cost;
    }

    result.push({
      date,
      byModel,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostEquiv: totalCost,
    });
  }

  return result;
}

/**
 * Get usage summary across all log files with plan limit percentages.
 */
export function getUsageSummary(
  logFiles: string[],
  planTier: PlanTier = "max_5x",
): UsageSummary {
  const now = Date.now();
  const windowStart = now - WEEKLY_WINDOW_MS;
  const allEntries: LogEntry[] = [];

  for (const file of logFiles) {
    const entries = parseJsonlLogs(file);
    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime >= windowStart) {
        allEntries.push(entry);
      }
    }
  }

  const { byModel, totalCostEquiv, pctOfLimit } = aggregateEntries(
    allEntries,
    planTier,
  );

  // Calculate weekly reset: time until oldest entry ages out
  let oldestTime = now;
  for (const entry of allEntries) {
    const t = new Date(entry.timestamp).getTime();
    if (t < oldestTime) oldestTime = t;
  }
  const weeklyResetsIn =
    allEntries.length > 0
      ? Math.max(0, oldestTime + WEEKLY_WINDOW_MS - now)
      : 0;

  return {
    byModel,
    totalCostEquiv,
    pctOfLimit,
    planTier,
    weeklyResetsIn,
  };
}

/**
 * Find all JSONL log files in Claude Code's projects directory.
 */
export function findLogFiles(projectsDir?: string): string[] {
  const dir = projectsDir || join(homedir(), ".claude", "projects");
  const files: string[] = [];

  try {
    const projects = readdirSync(dir);
    for (const project of projects) {
      const projectDir = join(dir, project);
      try {
        const stat = statSync(projectDir);
        if (!stat.isDirectory()) continue;
        const items = readdirSync(projectDir);
        for (const item of items) {
          if (item.endsWith(".jsonl")) {
            files.push(join(projectDir, item));
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  } catch {
    // Projects directory doesn't exist
  }

  return files;
}

/**
 * Format a millisecond countdown into human-readable string.
 */
export function formatResetCountdown(ms: number): string {
  if (ms <= 0) return "0m";

  const totalMinutes = Math.floor(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
