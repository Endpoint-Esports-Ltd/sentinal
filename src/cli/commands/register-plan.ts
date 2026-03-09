/**
 * Sentinal Register-Plan Command
 *
 * Syncs a plan file into SQLite with optional session association.
 *
 * Usage:
 *   sentinal register-plan <path> [--session <id>] [--project <path>] [--json]
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";

export function registerRegisterPlanCommand(program: Command): void {
  program
    .command("register-plan")
    .description("Register a plan file in SQLite (associates with spec index)")
    .argument("<path>", "Path to the plan markdown file")
    .option("-s, --session <id>", "Associate with a session ID")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option("--json", "Output as JSON")
    .action((planPath: string, opts: { session?: string; project: string; json?: boolean }) => {
      const absPath = resolve(planPath);

      if (!existsSync(absPath)) {
        if (opts.json) {
          console.log(JSON.stringify({ error: `File not found: ${absPath}` }));
        } else {
          console.error(`Error: File not found: ${absPath}`);
        }
        process.exitCode = 1;
        return;
      }

      const store = new MemoryStore();
      const specStore = new SpecStore(store);

      try {
        const spec = specStore.syncFromPlanFile(absPath, opts.project, opts.session);
        const done = spec.tasks.filter((t) => t.status === "complete").length;

        if (opts.json) {
          console.log(JSON.stringify({
            id: spec.id,
            title: spec.title,
            status: spec.status,
            tasks: spec.tasks.length,
            tasksDone: done,
            worktree: spec.metadata.worktree ?? false,
            sessionId: opts.session ?? null,
          }));
        } else {
          console.log(`Registered: ${spec.id} (${spec.status}, ${done}/${spec.tasks.length} tasks)`);
          if (spec.metadata.worktree) {
            console.log(`  Worktree: Yes — use \`sentinal worktree create\` to create an isolated worktree`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      } finally {
        store.close();
      }
    });
}
