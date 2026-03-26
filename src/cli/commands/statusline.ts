/**
 * Sentinal Statusline Command
 *
 * Reads Claude Code session JSON from stdin and outputs a formatted
 * status line for Claude Code's native statusline feature.
 *
 * Format:
 *   ⏱ Session: ▓░░░░ 10% (2h) | Opus: 4%, Sonnet: 6% (2d 4h) | Plan: Max 5x | 🧠 ▓░░░░ 10%
 */

import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getSessionWindowUsage,
  getUsageSummary,
  findLogFiles,
  formatResetCountdown,
  DISPLAY_MODELS,
  type PlanTier,
} from "../../sessions/usage-stats.js";
import { MemoryStore } from "../../memory/store.js";
import { stripJsoncComments } from "../../utils/shell.js";

// --- Types ---

export interface StatuslineInput {
  sessionPct: number;
  sessionDuration: string;
  modelUsage: Array<{ name: string; pct: number }>;
  weeklyResetCountdown: string;
  planTier: string;
  contextPct: number;
}

// --- Public API ---

/**
 * Check if Sentinal's statusline is the active plugin in Claude Code settings.
 * Returns true (active) if: command contains "sentinal", file missing, or unparseable.
 * Returns false if another plugin (e.g., ccstatusline) owns the statusline.
 */
export function isStatuslineActive(settingsPath?: string): boolean {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");

  if (!existsSync(path)) return true;

  try {
    const raw = readFileSync(path, "utf-8");
    const cleaned = stripJsoncComments(raw);
    const settings = JSON.parse(cleaned) as Record<string, unknown>;
    const statusLine = settings.statusLine as
      | Record<string, unknown>
      | undefined;
    const command =
      typeof statusLine?.command === "string" ? statusLine.command : null;

    if (!command) return true;

    return command.toLowerCase().includes("sentinal");
  } catch {
    // Can't read/parse — safe default: assume sentinal is active
    return true;
  }
}

/**
 * Detect plan tier from manual config and/or session context window size.
 * Manual config takes precedence. If no config, auto-detect from context window size
 * (1M+ tokens = Max 20x plan). Falls back to max_5x.
 */
export function detectPlanTier(
  configValue: string | null | undefined,
  contextWindowSize: number | undefined,
): PlanTier {
  // Manual config takes precedence
  if (configValue === "max_20x" || configValue === '"max_20x"') {
    return "max_20x";
  }

  // Auto-detect from context window size (1M+ = Max 20x)
  if (contextWindowSize !== undefined && contextWindowSize >= 1_000_000) {
    return "max_20x";
  }

  return "max_5x";
}

/**
 * Extract rate limit data from Claude Code's session JSON.
 * Returns null if rate_limit data is not present or invalid.
 */
export function extractRateLimits(
  sessionJson: Record<string, unknown>,
): { sessionPct: number; weeklyPct: number | undefined } | null {
  const rateLimit = sessionJson.rate_limit as
    | Record<string, unknown>
    | undefined;
  if (!rateLimit) return null;

  const sessionRaw = rateLimit.session_used_percentage;
  if (typeof sessionRaw !== "number") return null;

  const weeklyRaw = rateLimit.weekly_used_percentage;
  const weeklyPct =
    typeof weeklyRaw === "number" ? Math.round(weeklyRaw) : undefined;

  return { sessionPct: Math.round(sessionRaw), weeklyPct };
}

/**
 * Build a progress bar string.
 */
export function buildProgressBar(percent: number, width = 5): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Format the statusline string from structured input.
 */
export function formatStatusline(input: StatuslineInput): string {
  const sessionBar = buildProgressBar(input.sessionPct);
  const ctxBar = buildProgressBar(input.contextPct);

  const parts: string[] = [];

  // Session section
  parts.push(
    `⏱ Session: ${sessionBar} ${input.sessionPct}% (${input.sessionDuration})`,
  );

  // Model usage section
  if (input.modelUsage.length > 0) {
    const models = input.modelUsage
      .map((m) => `${m.name}: ${m.pct}%`)
      .join(", ");
    parts.push(`${models} (${input.weeklyResetCountdown})`);
  }

  // Plan tier
  parts.push(`Plan: ${input.planTier}`);

  // Context section
  parts.push(`🧠 ${ctxBar} ${input.contextPct}%`);

  return parts.join(" | ");
}

// --- CLI Registration ---

export function registerStatuslineCommand(program: Command): void {
  program
    .command("statusline")
    .description(
      "Output formatted statusline for Claude Code (reads session JSON from stdin)",
    )
    .action(async () => {
      try {
        // If another statusline plugin is active, drain stdin and yield silently
        if (!isStatuslineActive()) {
          process.stdin.resume();
          process.stdin.on("end", () => {});
          return;
        }

        // Read session JSON from stdin (Claude Code provides this)
        let stdinData = "";
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          stdinData = Buffer.concat(chunks).toString("utf-8");
        } catch {
          // No stdin available
        }

        let sessionJson: Record<string, unknown> = {};
        if (stdinData.trim()) {
          try {
            sessionJson = JSON.parse(stdinData);
          } catch {
            // Invalid JSON
          }
        }

        // Get context window data from session JSON
        const ctxWindow = sessionJson.context_window as
          | Record<string, unknown>
          | undefined;
        const contextWindowSize =
          typeof ctxWindow?.context_window_size === "number"
            ? ctxWindow.context_window_size
            : undefined;
        const contextPct =
          typeof ctxWindow?.used_percentage === "number"
            ? Math.round(ctxWindow.used_percentage)
            : 0;

        // Detect plan tier from config + session context window size
        let configValue: string | null = null;
        let planTier: PlanTier = "max_5x";
        try {
          const store = new MemoryStore();
          configValue = store.getSetting("plan_tier");
          planTier = detectPlanTier(configValue, contextWindowSize);
          // Auto-persist when detected from context window and no config exists
          if (!configValue && planTier === "max_20x") {
            store.setSetting("plan_tier", "max_20x");
          }
          store.close();
        } catch {
          // Fallback: detect without config
          planTier = detectPlanTier(null, contextWindowSize);
        }

        // Try to use Claude Code's rate_limit data (accurate server-side data)
        const rateLimits = extractRateLimits(sessionJson);

        // Get log files for model breakdown and fallback calculations
        const logFiles = findLogFiles();
        const summary = getUsageSummary(logFiles, planTier);

        // Session usage: prefer rate_limit, fall back to log-based
        let sessionPct: number;
        let sessionDuration: string;
        if (rateLimits) {
          sessionPct = rateLimits.sessionPct;
          // Session duration from log-based calculation (rate_limit doesn't include reset time)
          const sessionWindow = getSessionWindowUsage(logFiles, planTier);
          let sessionResetIn = 0;
          for (const [model, data] of Object.entries(sessionWindow.byModel)) {
            if (!DISPLAY_MODELS.has(model)) continue;
            if (data.resetsIn > sessionResetIn) {
              sessionResetIn = data.resetsIn;
            }
          }
          sessionDuration = formatResetCountdown(sessionResetIn);
        } else {
          const sessionWindow = getSessionWindowUsage(logFiles, planTier);
          sessionPct = sessionWindow.pctOfLimit;
          let sessionResetIn = 0;
          for (const [model, data] of Object.entries(sessionWindow.byModel)) {
            if (!DISPLAY_MODELS.has(model)) continue;
            if (data.resetsIn > sessionResetIn) {
              sessionResetIn = data.resetsIn;
            }
          }
          sessionDuration = formatResetCountdown(sessionResetIn);
        }

        // Build model usage array (only display known models)
        const modelUsage: Array<{ name: string; pct: number }> = [];
        let displayModelsResetIn = 0;

        // Calculate log-based model proportions
        const logModelEntries: Array<{
          name: string;
          pct: number;
          cost: number;
        }> = [];
        let totalDisplayCost = 0;
        for (const [model, data] of Object.entries(summary.byModel)) {
          if (!DISPLAY_MODELS.has(model)) continue;
          const shortName = model.includes("opus") ? "Opus" : "Sonnet";
          logModelEntries.push({
            name: shortName,
            pct: data.pctOfLimit,
            cost: data.costEquiv,
          });
          totalDisplayCost += data.costEquiv;
          if (data.resetsIn > displayModelsResetIn) {
            displayModelsResetIn = data.resetsIn;
          }
        }

        if (rateLimits?.weeklyPct !== undefined && totalDisplayCost > 0) {
          // Scale model percentages to match Claude Code's weekly total
          for (const entry of logModelEntries) {
            const proportion = entry.cost / totalDisplayCost;
            modelUsage.push({
              name: entry.name,
              pct: Math.round(proportion * rateLimits.weeklyPct),
            });
          }
        } else {
          // Fall back to log-based percentages
          for (const entry of logModelEntries) {
            modelUsage.push({ name: entry.name, pct: entry.pct });
          }
        }

        // Format and output
        const line = formatStatusline({
          sessionPct,
          sessionDuration,
          modelUsage,
          weeklyResetCountdown: formatResetCountdown(displayModelsResetIn),
          planTier: planTier === "max_20x" ? "Max 20x" : "Max 5x",
          contextPct,
        });

        process.stdout.write(line);
      } catch {
        // Statusline should never fail visibly
        process.stdout.write("⏱ Session: ░░░░░ 0% | 🧠 ░░░░░ 0%");
      }
    });
}
