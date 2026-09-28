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
import { OBSERVATION_TYPES } from "./types.js";
import { runMemorySetup } from "./setup.js";
import type { MemorySetupOptions } from "./setup.js";
import {
  runSearch,
  runList,
  runTimeline,
  runGet,
  runExport,
  runStats,
  runUpdate,
  runDelete,
  runPrune,
  runDecay,
  runMaintain,
  runRepair,
  type ParsedArgs,
} from "./cli-commands.js";

// Subcommands live in cli-commands.ts (split for length); re-exported so
// callers and tests keep importing them from here.
export {
  runSearch,
  runList,
  runTimeline,
  runGet,
  runExport,
  runStats,
  runUpdate,
  runDelete,
  runPrune,
  runDecay,
  runMaintain,
};

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

/**
 * `sentinal memory setup` — provision ~/.sentinal/deps with native deps
 * (sqlite-vec, @xenova/transformers) for compiled binaries.
 * Sets a non-zero exit code when deps remain unavailable.
 */
export async function runSetupCommand(
  opts: MemorySetupOptions = {},
): Promise<string> {
  const result = await runMemorySetup(opts);
  if (!result.ok) process.exitCode = 1;
  return result.report;
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
  update <id>        Correct an observation in place (refreshes staleness)
  delete <id>        Delete an observation (destructive, removes vector)
  export             Export all observations
  stats              Show database statistics
  prune              Remove old observations
  decay              Decay quality scores by age (--dry-run to preview)
  maintain <action>  Run decay|prune|stats (prune needs --apply to delete)
  repair             Check integrity and rebuild FTS index
  setup              Install native deps for vector search (~/.sentinal/deps)

Options:
  --project <path>   Filter by project path
  --type <type>      Filter by type (${OBSERVATION_TYPES.join(", ")})
  --limit <n>        Max results (default 20)
  --anchor <id>      Observation ID for timeline
  --depth <n>        Timeline depth (default 5)
  --format <fmt>     Export format: json (default) or markdown
  --older-than <dur> Prune duration: 30d, 90d, 1y, etc.
  --title <t>        New title (update)
  --content <c>      New content (update)
  --type <type>      New type (update)
  --tags <a,b,c>     Comma-separated tags (update)
  --files <a,b,c>    Comma-separated file paths (update)
  --dry-run          Preview without writing (decay/maintain)
  --apply            Actually delete (maintain prune)`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<string> {
  const args = parseArgs(argv);

  // Commands that must run BEFORE any Database is opened:
  // `setup` calls Database.setCustomSQLite() (macOS), which fails once any
  // Database instance exists in the process.
  switch (args.command) {
    case "setup":
      return await runSetupCommand();
    case "help":
    case "--help":
    case "-h":
      return showHelp();
  }

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
      case "update":
        return runUpdate(service, args);
      case "delete":
        return runDelete(service, args);
      case "export":
        return runExport(service, args);
      case "stats":
        return runStats(service);
      case "prune":
        return runPrune(service, args);
      case "decay":
        return runDecay(service, args);
      case "maintain":
        return runMaintain(service, args);
      case "repair":
        return runRepair(service);
      default:
        return `Unknown command: ${args.command}\n\n${showHelp()}`;
    }
  } finally {
    service.close();
  }
}

// Only run main when executed directly (not when imported by the CLI dispatcher)
const isMainModule =
  !process.env.__SENTINAL_CLI &&
  (typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : import.meta.url === `file://${process.argv[1]}`);

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
