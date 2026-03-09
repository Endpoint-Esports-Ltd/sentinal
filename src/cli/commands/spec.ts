/**
 * Sentinal Spec Command
 *
 * CLI commands for managing spec/plan files and their SQLite index.
 *
 * Usage:
 *   sentinal spec list    [--project <path>]  List all specs
 *   sentinal spec current [--project <path>]  Show the current active spec
 *   sentinal spec sync    [--project <path>]  Sync all plan files to SQLite
 */

import type { Command } from "commander";
import { join } from "node:path";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";

// --- Register ---

export function registerSpecCommand(program: Command): void {
  const spec = program
    .command("spec")
    .description("Spec workflow — list, current, sync plan files");

  spec
    .command("list")
    .description("List all specs for a project")
    .option("-p, --project <path>", "Project path", process.cwd())
    .action((opts: { project: string }) => {
      const store = new MemoryStore();
      const specStore = new SpecStore(store);
      const specs = specStore.listSpecs(opts.project);

      if (specs.length === 0) {
        console.log("No specs found. Run `sentinal spec sync` to import plan files.");
        store.close();
        return;
      }

      const header = "  ID                                    | Status       | Type    | Tasks";
      const sep    = "----------------------------------------|--------------|---------|------";
      const rows = specs.map((s) => {
        const done = s.tasks.filter((t) => t.status === "complete").length;
        return `  ${s.id.padEnd(38)} | ${s.status.padEnd(12)} | ${s.type.padEnd(7)} | ${done}/${s.tasks.length}`;
      });

      console.log(header);
      console.log(sep);
      for (const row of rows) console.log(row);
      store.close();
    });

  spec
    .command("current")
    .description("Show the current active spec")
    .option("-p, --project <path>", "Project path", process.cwd())
    .action((opts: { project: string }) => {
      const store = new MemoryStore();
      const specStore = new SpecStore(store);
      const current = specStore.getCurrentSpec(opts.project);

      if (!current) {
        console.log("No active spec found.");
        store.close();
        return;
      }

      const done = current.tasks.filter((t) => t.status === "complete").length;
      const pct = current.tasks.length > 0 ? Math.round((done / current.tasks.length) * 100) : 0;

      console.log(`${current.title}`);
      console.log(`  ID:       ${current.id}`);
      console.log(`  Status:   ${current.status}`);
      console.log(`  Type:     ${current.type}`);
      console.log(`  Progress: ${done}/${current.tasks.length} (${pct}%)`);
      console.log(`  Plan:     ${current.planFile}`);

      if (current.tasks.length > 0) {
        console.log("");
        for (const task of current.tasks) {
          const marker = task.status === "complete" ? "[x]" : task.status === "in-progress" ? "[~]" : "[ ]";
          console.log(`  ${marker} Task ${task.position}: ${task.title}`);
        }
      }

      store.close();
    });

  spec
    .command("sync")
    .description("Sync all plan files from docs/plans/ into SQLite index")
    .option("-p, --project <path>", "Project path", process.cwd())
    .action((opts: { project: string }) => {
      const store = new MemoryStore();
      const specStore = new SpecStore(store);
      const plansDir = join(opts.project, "docs", "plans");
      const count = specStore.syncAllPlans(plansDir, opts.project);
      console.log(`Synced ${count} plan file(s) from ${plansDir}`);
      store.close();
    });
}
