/**
 * Sentinal Check-Context Command
 *
 * Estimates context window usage from a transcript file.
 *
 * Usage:
 *   sentinal check-context <transcript-path>   Estimate from file path
 *   sentinal check-context --session <id>       Look up transcript from session record
 *   sentinal check-context --json               Machine-readable output
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import { estimateContextUsage } from "../../sessions/context.js";

export function registerCheckContextCommand(program: Command): void {
  program
    .command("check-context [path]")
    .description("Estimate context window usage from transcript file size")
    .option("-s, --session <id>", "Look up transcript path from a session record")
    .option("--json", "Output as JSON")
    .action((path: string | undefined, opts: { session?: string; json?: boolean }) => {
      let transcriptPath = path;

      if (opts.session) {
        const store = new MemoryStore();
        const session = store.getSession(opts.session);
        store.close();

        if (!session) {
          if (opts.json) {
            console.log(JSON.stringify({ error: `Session "${opts.session}" not found` }));
          } else {
            console.error(`Error: Session "${opts.session}" not found.`);
          }
          process.exit(1);
        }

        if (!session.transcriptPath) {
          if (opts.json) {
            console.log(JSON.stringify({ error: `Session "${opts.session}" has no transcript path` }));
          } else {
            console.error(`Error: Session "${opts.session}" has no transcript path stored.`);
          }
          process.exit(1);
        }

        transcriptPath = session.transcriptPath;
      }

      if (!transcriptPath) {
        if (opts.json) {
          console.log(JSON.stringify({ error: "No transcript path provided" }));
        } else {
          console.error("Error: Provide a transcript path or use --session <id>.");
        }
        process.exit(1);
      }

      const usage = estimateContextUsage(transcriptPath);

      if (opts.json) {
        console.log(JSON.stringify(usage));
      } else {
        const tokensFormatted = usage.tokens.toLocaleString();
        console.log(`Context: ${usage.percent}% (~${tokensFormatted} tokens)`);
        if (usage.percent >= 90) {
          console.log("Warning: Context window nearly full. Consider compacting.");
        }
      }
    });
}
