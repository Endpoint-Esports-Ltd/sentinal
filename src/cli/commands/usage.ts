/**
 * Sentinal Usage Command
 *
 * On-demand detailed usage report showing per-model token counts,
 * % of plan limit, daily breakdown, and reset countdowns.
 *
 * Usage:
 *   sentinal usage              Show usage report (last 7 days)
 *   sentinal usage --days 14    Show last 14 days
 *   sentinal usage --json       Output as JSON
 */

import type { Command } from "commander";
import {
  getUsageSummary,
  getDailyUsage,
  findLogFiles,
  formatResetCountdown,
  type PlanTier,
} from "../../sessions/usage-stats.js";
import { MemoryStore } from "../../memory/store.js";
import { formatTokens } from "../../sessions/context-display.js";

// --- Types ---

export interface ModelSummaryEntry {
  name: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  costEquiv: number;
  pctOfLimit: number;
  resetsIn: string;
}

export interface DailyEntry {
  date: string;
  totalCostEquiv: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface UsageReportInput {
  planTier: string;
  weeklyResetCountdown: string;
  modelSummary: ModelSummaryEntry[];
  totalCostEquiv: number;
  totalPctOfLimit: number;
  dailyUsage: DailyEntry[];
}

// --- Public API ---

/**
 * Build a visual bar string for usage display.
 */
export function formatUsageBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Format a full usage report from structured input.
 */
export function formatUsageReport(
  input: UsageReportInput,
  json = false,
): string {
  if (json) {
    return JSON.stringify(input, null, 2);
  }

  const lines: string[] = [];

  // Header
  lines.push("╔══════════════════════════════════════════════════════╗");
  lines.push(`║  Sentinal Usage Report — Plan: ${input.planTier.padEnd(22)}║`);
  lines.push("╠══════════════════════════════════════════════════════╣");

  // Weekly summary
  lines.push(
    `║  Weekly Total: $${input.totalCostEquiv.toFixed(2)} (${input.totalPctOfLimit}% of limit)`.padEnd(
      55,
    ) + "║",
  );
  lines.push(`║  Resets in: ${input.weeklyResetCountdown}`.padEnd(55) + "║");
  lines.push("╠══════════════════════════════════════════════════════╣");

  // Model breakdown
  lines.push("║  Model Breakdown:".padEnd(55) + "║");
  lines.push("║".padEnd(55) + "║");

  for (const model of input.modelSummary) {
    const bar = formatUsageBar(model.pctOfLimit, 15);
    lines.push(
      `║  ${model.displayName.padEnd(8)} ${bar} ${String(model.pctOfLimit).padStart(3)}%`.padEnd(
        55,
      ) + "║",
    );
    lines.push(
      `║           In: ${formatTokens(model.inputTokens).padEnd(8)} Out: ${formatTokens(model.outputTokens).padEnd(8)} ~$${model.costEquiv.toFixed(2)}`.padEnd(
        55,
      ) + "║",
    );
    lines.push(`║           Resets in: ${model.resetsIn}`.padEnd(55) + "║");
  }

  // Daily breakdown
  if (input.dailyUsage.length > 0) {
    lines.push("╠══════════════════════════════════════════════════════╣");
    lines.push("║  Daily Breakdown:".padEnd(55) + "║");
    lines.push("║  Date         Input      Output     Cost".padEnd(55) + "║");
    lines.push("║  ──────────   ────────   ────────   ──────".padEnd(55) + "║");

    for (const day of input.dailyUsage) {
      const line = `║  ${day.date}   ${formatTokens(day.totalInputTokens).padEnd(10)} ${formatTokens(day.totalOutputTokens).padEnd(10)} $${day.totalCostEquiv.toFixed(2)}`;
      lines.push(line.padEnd(55) + "║");
    }
  }

  lines.push("╚══════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

// --- CLI Registration ---

export function registerUsageCommand(program: Command): void {
  program
    .command("usage")
    .description("Show detailed usage report with plan limit percentages")
    .option("-d, --days <n>", "Number of days to show in daily breakdown", "7")
    .option("--json", "Output as JSON")
    .action((opts: { days: string; json?: boolean }) => {
      const days = parseInt(opts.days, 10) || 7;

      // Get plan tier from config
      let planTier: PlanTier = "max_5x";
      try {
        const store = new MemoryStore();
        const raw = store.getSetting("plan_tier");
        if (raw === '"max_20x"' || raw === "max_20x") {
          planTier = "max_20x";
        }
        store.close();
      } catch {
        // Use default
      }

      // Get usage data
      const logFiles = findLogFiles();

      if (logFiles.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ error: "No usage data found" }));
        } else {
          console.log(
            "No usage data found. Start a Claude Code session to begin tracking.",
          );
        }
        return;
      }

      const summary = getUsageSummary(logFiles, planTier);
      const daily = getDailyUsage(logFiles);

      // Build model summary
      const modelSummary: ModelSummaryEntry[] = [];
      for (const [model, data] of Object.entries(summary.byModel)) {
        const displayName = model.includes("opus")
          ? "Opus"
          : model.includes("sonnet")
            ? "Sonnet"
            : model;
        modelSummary.push({
          name: model,
          displayName,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costEquiv: data.costEquiv,
          pctOfLimit: data.pctOfLimit,
          resetsIn: formatResetCountdown(data.resetsIn),
        });
      }

      // Filter daily to requested number of days
      const recentDaily = daily.slice(-days).map((d) => ({
        date: d.date,
        totalCostEquiv: d.totalCostEquiv,
        totalInputTokens: d.totalInputTokens,
        totalOutputTokens: d.totalOutputTokens,
      }));

      const reportInput: UsageReportInput = {
        planTier: planTier === "max_20x" ? "Max 20x" : "Max 5x",
        weeklyResetCountdown: formatResetCountdown(summary.weeklyResetsIn),
        modelSummary,
        totalCostEquiv: summary.totalCostEquiv,
        totalPctOfLimit: summary.pctOfLimit,
        dailyUsage: recentDaily,
      };

      console.log(formatUsageReport(reportInput, opts.json));
    });
}
