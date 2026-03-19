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
import {
  getSessionWindowUsage,
  getUsageSummary,
  findLogFiles,
  formatResetCountdown,
  DISPLAY_MODELS,
  type PlanTier,
} from "../../sessions/usage-stats.js";
import { MemoryStore } from "../../memory/store.js";

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

        // Get all log files (used for both session and weekly calculations)
        const logFiles = findLogFiles();

        // Calculate 4-hour session window usage across all projects
        const sessionWindow = getSessionWindowUsage(logFiles, planTier);
        const sessionPct = sessionWindow.pctOfLimit;
        let sessionResetIn = 0;
        for (const [model, data] of Object.entries(sessionWindow.byModel)) {
          if (!DISPLAY_MODELS.has(model)) continue;
          if (data.resetsIn > sessionResetIn) {
            sessionResetIn = data.resetsIn;
          }
        }
        const sessionDuration = formatResetCountdown(sessionResetIn);
        const summary = getUsageSummary(logFiles, planTier);

        // Build model usage array (only display known models, not background ones like haiku)
        const modelUsage: Array<{ name: string; pct: number }> = [];
        let displayModelsResetIn = 0;
        for (const [model, data] of Object.entries(summary.byModel)) {
          if (!DISPLAY_MODELS.has(model)) continue;
          const shortName = model.includes("opus") ? "Opus" : "Sonnet";
          modelUsage.push({ name: shortName, pct: data.pctOfLimit });
          if (data.resetsIn > displayModelsResetIn) {
            displayModelsResetIn = data.resetsIn;
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
