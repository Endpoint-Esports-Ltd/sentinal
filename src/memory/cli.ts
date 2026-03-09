/**
 * Memory CLI
 *
 * Command-line interface for the persistent memory system.
 *
 * Usage:
 *   sentinal memory search "auth token"
 *   sentinal memory list --project . --type decision --limit 20
 *   sentinal memory timeline --anchor 42 --depth 5
 *   sentinal memory get 42 43 44
 *   sentinal memory export --format json
 *   sentinal memory stats
 *   sentinal memory prune --older-than 90d
 *
 * Run directly: bun src/memory/cli.ts <command> [options]
 */

import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { rebuildFtsIndex, backupDatabase, checkIntegrity } from "./maintenance.js";
import type { ObservationType } from "./types.js";
import { OBSERVATION_TYPES } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function runSearch(service: MemoryService, args: ParsedArgs): Promise<string> {
  const query = args.positional.join(" ");
  if (!query) return "Usage: sentinal memory search <query> [--project <path>] [--type <type>] [--limit <n>]";

  const results = await service.search(query, {
    project: args.flags.project,
    type: args.flags.type as ObservationType | undefined,
    limit: args.flags.limit ? parseInt(args.flags.limit, 10) : 20,
  });

  if (results.length === 0) return "No matching observations found.";

  const header = "  ID | Date       | Type       | Title";
  const sep    = "-----|------------|------------|------";
  const rows = results.map((r) => {
    const date = new Date(r.timestamp).toISOString().split("T")[0];
    return `${String(r.id).padStart(4)} | ${date} | ${r.type.padEnd(10)} | ${r.title}`;
  });

  return [header, sep, ...rows].join("\n");
}

export async function runList(service: MemoryService, args: ParsedArgs): Promise<string> {
  const results = await service.search("", {
    project: args.flags.project,
    type: args.flags.type as ObservationType | undefined,
    limit: args.flags.limit ? parseInt(args.flags.limit, 10) : 20,
    orderBy: "date_desc",
  });

  if (results.length === 0) return "No observations found.";

  const header = "  ID | Date       | Type       | Title";
  const sep    = "-----|------------|------------|------";
  const rows = results.map((r) => {
    const date = new Date(r.timestamp).toISOString().split("T")[0];
    return `${String(r.id).padStart(4)} | ${date} | ${r.type.padEnd(10)} | ${r.title}`;
  });

  return [header, sep, ...rows].join("\n");
}

export function runTimeline(service: MemoryService, args: ParsedArgs): string {
  const anchorId = parseInt(args.flags.anchor ?? args.positional[0] ?? "", 10);
  if (isNaN(anchorId)) return "Usage: sentinal memory timeline --anchor <id> [--depth <n>] [--project <path>]";

  const depth = parseInt(args.flags.depth ?? "5", 10);
  const result = service.timeline(anchorId, depth, depth, args.flags.project);

  if (result.entries.length === 0) return `Observation #${anchorId} not found.`;

  const lines = result.entries.map((e) => {
    const date = new Date(e.timestamp).toISOString().split("T")[0];
    const marker = e.isAnchor ? ">>>" : "   ";
    return `${marker} [${e.id}] ${date} (${e.type}) ${e.title}`;
  });

  return lines.join("\n");
}

export function runGet(service: MemoryService, args: ParsedArgs): string {
  const ids = args.positional.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) return "Usage: sentinal memory get <id> [<id> ...]";

  const observations = service.getObservations(ids);
  if (observations.length === 0) return "No observations found for the given IDs.";

  const blocks = observations.map((obs) => {
    const date = new Date(obs.timestamp).toISOString().split("T")[0];
    const lines = [
      `# Observation #${obs.id}`,
      `Type:    ${obs.type}`,
      `Date:    ${date}`,
      `Project: ${obs.projectPath}`,
    ];

    if (obs.tags.length > 0) lines.push(`Tags:    ${obs.tags.join(", ")}`);
    if (obs.filePaths.length > 0) lines.push(`Files:   ${obs.filePaths.join(", ")}`);

    lines.push("", `## ${obs.title}`, "", obs.content);
    return lines.join("\n");
  });

  return blocks.join("\n\n---\n\n");
}

export function runExport(service: MemoryService, args: ParsedArgs): string {
  const format = args.flags.format ?? "json";
  const results = service.getRecentForProject(args.flags.project ?? "", 200);

  // If no project filter, get all via search
  const observations = args.flags.project
    ? results
    : service.getObservations(
        service.searchSync("", { limit: 200 }).map((r) => r.id),
      );

  if (format === "json") {
    return JSON.stringify(observations, null, 2);
  }

  // Markdown format
  return observations
    .map((obs) => {
      const date = new Date(obs.timestamp).toISOString().split("T")[0];
      return `## ${obs.title}\n\n- **Type:** ${obs.type}\n- **Date:** ${date}\n- **Project:** ${obs.projectPath}\n\n${obs.content}`;
    })
    .join("\n\n---\n\n");
}

export function runStats(service: MemoryService): string {
  const stats = service.getStats();

  const lines = [
    "Memory Statistics",
    "=================",
    "",
    `Total Observations: ${stats.totalObservations}`,
    `Total Sessions:     ${stats.totalSessions}`,
    `Database Size:      ${(stats.databaseSizeBytes / 1024).toFixed(1)} KB`,
  ];

  if (stats.oldestTimestamp && stats.newestTimestamp) {
    const oldest = new Date(stats.oldestTimestamp).toISOString().split("T")[0];
    const newest = new Date(stats.newestTimestamp).toISOString().split("T")[0];
    lines.push(`Date Range:         ${oldest} to ${newest}`);
  }

  const typeEntries = Object.entries(stats.byType).filter(([, v]) => v > 0);
  if (typeEntries.length > 0) {
    lines.push("", "By Type:");
    for (const [t, count] of typeEntries) {
      lines.push(`  ${t}: ${count}`);
    }
  }

  const projectEntries = Object.entries(stats.byProject);
  if (projectEntries.length > 0) {
    lines.push("", "By Project:");
    for (const [p, count] of projectEntries) {
      lines.push(`  ${p}: ${count}`);
    }
  }

  return lines.join("\n");
}

export function runPrune(service: MemoryService, args: ParsedArgs): string {
  const olderThan = args.flags["older-than"] ?? "90d";
  const ms = parseDuration(olderThan);
  if (ms === null) return "Invalid duration. Use format: 30d, 90d, 1y, etc.";

  const count = service.prune(ms);
  return count > 0
    ? `Pruned ${count} observation(s) older than ${olderThan}.`
    : `No observations older than ${olderThan} to prune.`;
}

export function runRepair(service: MemoryService): string {
  const store = service.getStore();
  const lines: string[] = ["Database Repair", "===============", ""];

  // 1. Integrity check
  const issues = checkIntegrity(store);
  if (issues) {
    lines.push(`Integrity issues found: ${issues.length}`);
    for (const issue of issues.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
  } else {
    lines.push("Integrity check: OK");
  }

  // 2. Rebuild FTS index
  const ftsCount = rebuildFtsIndex(store);
  lines.push(`FTS index rebuilt: ${ftsCount} observation(s) indexed`);

  lines.push("", "Repair complete.");
  return lines.join("\n");
}

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)([dhmy])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    m: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };

  return value * (multipliers[unit] ?? 0);
}

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp(): string {
  return `Sentinal Memory CLI

Usage: sentinal memory <command> [options]

Commands:
  search <query>     Search observations (semantic + keyword)
  list               List recent observations
  timeline           Show chronological context around an observation
  get <id> [<id>...] Get full observation details
  export             Export all observations
  stats              Show database statistics
  prune              Remove old observations
  repair             Check integrity and rebuild FTS index

Options:
  --project <path>   Filter by project path
  --type <type>      Filter by type (${OBSERVATION_TYPES.join(", ")})
  --limit <n>        Max results (default 20)
  --anchor <id>      Observation ID for timeline
  --depth <n>        Timeline depth (default 5)
  --format <fmt>     Export format: json (default) or markdown
  --older-than <dur> Prune duration: 30d, 90d, 1y, etc.`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<string> {
  const args = parseArgs(argv);

  const store = new MemoryStore();
  const service = new MemoryService(store);

  try {
    switch (args.command) {
      case "search":
        return await runSearch(service, args);
      case "list":
        return await runList(service, args);
      case "timeline":
        return runTimeline(service, args);
      case "get":
        return runGet(service, args);
      case "export":
        return runExport(service, args);
      case "stats":
        return runStats(service);
      case "prune":
        return runPrune(service, args);
      case "repair":
        return runRepair(service);
      case "help":
      case "--help":
      case "-h":
        return showHelp();
      default:
        return `Unknown command: ${args.command}\n\n${showHelp()}`;
    }
  } finally {
    service.close();
  }
}

// Only run main when executed directly (not when imported by the CLI dispatcher)
const isMainModule = !process.env.__SENTINAL_CLI && (
  typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : import.meta.url === `file://${process.argv[1]}`
);

if (isMainModule) {
  const argv = process.argv.slice(2);
  // If invoked as "sentinal memory <cmd>", skip "memory"
  const effectiveArgs = argv[0] === "memory" ? argv.slice(1) : argv;
  runCli(effectiveArgs)
    .then((output) => console.log(output))
    .catch((err) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}
