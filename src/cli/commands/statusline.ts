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
  getSessionUsage,
  getUsageSummary,
  findLogFiles,
  formatResetCountdown,
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

        // Get context % from session JSON (Claude Code provides context_window.used_percentage)
        const ctxWindow = sessionJson.context_window as
          | Record<string, unknown>
          | undefined;
        const contextPct =
          typeof ctxWindow?.used_percentage === "number"
            ? Math.round(ctxWindow.used_percentage)
            : 0;

        // Get transcript path for session usage
        const transcriptPath =
          typeof sessionJson.transcript_path === "string"
            ? sessionJson.transcript_path
            : "";

        // Calculate session usage from transcript
        let sessionPct = 0;
        if (transcriptPath) {
          const sessionUsage = getSessionUsage(transcriptPath, planTier);
          sessionPct = sessionUsage.pctOfLimit;
        }

        // Calculate session duration from cost.total_duration_ms
        const cost = sessionJson.cost as Record<string, unknown> | undefined;
        const durationMs =
          typeof cost?.total_duration_ms === "number"
            ? cost.total_duration_ms
            : 0;
        const sessionDuration = formatDuration(durationMs);

        // Get weekly usage summary
        const logFiles = findLogFiles();
        const summary = getUsageSummary(logFiles, planTier);

        // Build model usage array
        const modelUsage: Array<{ name: string; pct: number }> = [];
        for (const [model, data] of Object.entries(summary.byModel)) {
          const shortName = model.includes("opus")
            ? "Opus"
            : model.includes("sonnet")
              ? "Sonnet"
              : model;
          modelUsage.push({ name: shortName, pct: data.pctOfLimit });
        }

        // Format and output
        const line = formatStatusline({
          sessionPct,
          sessionDuration,
          modelUsage,
          weeklyResetCountdown: formatResetCountdown(summary.weeklyResetsIn),
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

// --- Helpers ---

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
