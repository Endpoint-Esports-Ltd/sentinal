/**
 * Sentinal Sessions Command
 *
 * CLI commands for listing and managing sessions.
 *
 * Usage:
 *   sentinal sessions list                     List all sessions
 *   sentinal sessions list --active            List active sessions only
 *   sentinal sessions list --project <path>    Filter by project
 *   sentinal sessions list --json              Output as JSON
 *   sentinal sessions cleanup                  End stale sessions (24h default)
 *   sentinal sessions cleanup --threshold <h>  Custom threshold in hours
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import type { Session } from "../../memory/types.js";

export function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Manage sessions — list, cleanup stale");

  sessions
    .command("list")
    .description("List sessions")
    .option("--active", "Show only active sessions")
    .option("-p, --project <path>", "Filter by project path")
    .option("--json", "Output as JSON")
    .option("-n, --limit <count>", "Max sessions to show", "20")
    .action((opts: { active?: boolean; project?: string; json?: boolean; limit: string }) => {
      const store = new MemoryStore();
      const results = store.listSessions({
        active: opts.active || undefined,
        project: opts.project,
        limit: parseInt(opts.limit, 10),
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        console.log("No sessions found.");
      } else {
        printSessionTable(results);
      }

      store.close();
    });

  sessions
    .command("cleanup")
    .description("End stale sessions that have been active too long")
    .option("--threshold <hours>", "Hours before a session is considered stale", "24")
    .option("--json", "Output as JSON")
    .action((opts: { threshold: string; json?: boolean }) => {
      const store = new MemoryStore();
      const hours = parseFloat(opts.threshold);
      const thresholdMs = hours * 60 * 60 * 1000;
      const count = store.cleanupStaleSessions(thresholdMs);

      if (opts.json) {
        console.log(JSON.stringify({ cleaned: count, thresholdHours: hours }));
      } else if (count === 0) {
        console.log("No stale sessions found.");
      } else {
        console.log(`Ended ${count} stale session(s) (threshold: ${hours}h).`);
      }

      store.close();
    });
}

// --- Helpers ---

function printSessionTable(sessions: Session[]): void {
  const header = "ID                                   | Project          | Assistant   | Started              | Duration     | Status";
  const separator = "-".repeat(header.length);

  console.log(header);
  console.log(separator);

  for (const s of sessions) {
    const id = s.id.length > 36 ? s.id.slice(0, 36) : s.id.padEnd(36);
    const project = truncate(s.projectPath.split("/").pop() || s.projectPath, 16);
    const assistant = s.assistant.padEnd(11);
    const started = new Date(s.startTime).toISOString().replace("T", " ").slice(0, 19);
    const duration = s.endTime ? formatDuration(s.endTime - s.startTime) : "active";
    const status = s.endTime ? "ended" : "active";

    console.log(`${id} | ${project} | ${assistant} | ${started} | ${duration.padEnd(12)} | ${status}`);
  }

  console.log(`\n${sessions.length} session(s)`);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str.padEnd(maxLen);
  return str.slice(0, maxLen - 1) + "\u2026";
}
