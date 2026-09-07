/**
 * Destructive worktree CLI commands: `cleanup` and `abandon-orphan`.
 *
 * Split out of `worktree.ts` (issue #9) because that file was already at
 * 428/400 lines before this work — the same cohesion split precedent as
 * `src/worktree/cleanup.ts` and `src/runtime/lifecycle-mcp-tools.ts`.
 *
 * WHY THESE EXIST
 *
 * The MCP tool exposed `force`; the CLI did not. When the MCP path was failing
 * (a timeout misreported as "sidecar unreachable"), the reporter tried
 * `sentinal worktree cleanup --force` and got `error: unknown option
 * '--force'`. There was no fallback. Separately, `worktree_abandon` resolves
 * only ACTIVE database records, so a worktree left by a crashed session was
 * unreachable by any sentinal command — plain `git worktree remove --force`
 * was the only route, which is exactly the manual `rm -rf` the guards exist to
 * prevent.
 *
 * ⛔ THE DANGEROUS PART
 *
 * The old CLI called `manager.cleanup()` with NO options at all. Adding
 * `--force` without threading the guards' inputs would be strictly worse than
 * the bug: guard 5 ("never remove a worktree that still owns running
 * processes") fails CLOSED and refuses the whole pass, and guards 3 and 4 have
 * nothing to evaluate. Every construction site here therefore supplies
 * `projectPath`, `currentWorktree` and a real `isPlanActive`, and builds the
 * manager with `runtimeWorktreeConfig()` so guard 5 has its resolver.
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import { SpecStore } from "../../spec/store.js";
import { WorktreeStore } from "../../worktree/store.js";
import { WorktreeManager } from "../../worktree/manager.js";
import type { RemovedWorktree } from "../../worktree/cleanup.js";
import { runtimeWorktreeConfig } from "../../runtime/worktree-deps.js";

interface Ctx {
  manager: WorktreeManager;
  specStore: SpecStore;
  store: MemoryStore;
}

/**
 * ⛔ `runtimeWorktreeConfig()` is mandatory, not decorative: without it
 * `config.ownsLiveRuntime` is undefined and the entire `force` pass is refused
 * (see `cleanup.ts`). A manager built with the bare default config cannot
 * force-clean anything.
 */
function createCtx(): Ctx {
  const store = new MemoryStore();
  const manager = new WorktreeManager(
    new WorktreeStore(store),
    runtimeWorktreeConfig(),
  );
  return { manager, specStore: new SpecStore(store), store };
}

function printRemoved(removed: RemovedWorktree[]): void {
  for (const r of removed) {
    console.log(`  - ${r.path} (branch ${r.branch}, ${r.pass})`);
  }
}

export function registerWorktreeCleanupCommands(wt: Command): void {
  // ─── abandon ────────────────────────────────────────────────────────────

  wt.command("abandon")
    .description("Abandon a worktree (remove from disk, mark as abandoned)")
    .argument("<id>", "Worktree ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { manager, store } = createCtx();
      try {
        await manager.abandon(id);
        if (opts.json) {
          console.log(JSON.stringify({ id, status: "abandoned" }));
        } else {
          console.log(`Abandoned: ${id}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) console.log(JSON.stringify({ error: msg }));
        else console.error(`Error: ${msg}`);
        process.exitCode = 1;
      } finally {
        store.close();
      }
    });

  // ─── cleanup ────────────────────────────────────────────────────────────

  wt.command("cleanup")
    .description("Remove stale/orphaned worktrees")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option(
      "-f, --force",
      "ALSO remove orphaned worktrees whose directory still exists " +
        "(DESTRUCTIVE — deletes directories and branches)",
    )
    .option(
      "--current-worktree <path>",
      "Your own worktree — never removed (defaults to cwd)",
      process.cwd(),
    )
    .option("--json", "Output as JSON")
    .action(
      (opts: {
        project: string;
        force?: boolean;
        currentWorktree: string;
        json?: boolean;
      }) => {
        const { manager, specStore, store } = createCtx();
        try {
          const warnings: string[] = [];
          const { cleaned, removed } = manager.cleanup({
            force: opts.force === true,
            projectPath: opts.project,
            currentWorktree: opts.currentWorktree,
            isPlanActive: (slug) =>
              specStore.getSpec(slug)?.status === "IN_PROGRESS",
            warnings,
          });

          if (opts.json) {
            console.log(JSON.stringify({ cleaned, removed, warnings }));
          } else {
            console.log(`Cleaned up ${cleaned} stale worktree(s).`);
            printRemoved(removed);
            for (const w of warnings) console.log(`  ! ${w}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) console.log(JSON.stringify({ error: msg }));
          else console.error(`Error: ${msg}`);
          process.exitCode = 1;
        } finally {
          store.close();
        }
      },
    );

  // ─── abandon-orphan ─────────────────────────────────────────────────────

  wt.command("abandon-orphan")
    .description(
      "Remove an on-disk worktree that has no active database record " +
        "(left by a crashed session). DESTRUCTIVE.",
    )
    .argument("<slug>", "Plan slug, e.g. '2026-03-12-add-auth'")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option(
      "--current-worktree <path>",
      "Your own worktree — never removed (defaults to cwd)",
      process.cwd(),
    )
    .option("--json", "Output as JSON")
    .action(
      (
        slug: string,
        opts: { project: string; currentWorktree: string; json?: boolean },
      ) => {
        const { manager, specStore, store } = createCtx();
        try {
          const warnings: string[] = [];
          // ⛔ Reuses the FULL five-guard force pass rather than reimplementing
          // removal. Narrowing is expressed through `isPlanActive`, which can
          // only ever PREVENT a removal: every slug except the requested one is
          // reported active and therefore skipped by guard 4. The target itself
          // is still subject to the real IN_PROGRESS check, so this cannot be
          // used to delete a worktree whose plan is running.
          const { removed } = manager.cleanup({
            force: true,
            projectPath: opts.project,
            currentWorktree: opts.currentWorktree,
            isPlanActive: (s) =>
              s !== slug || specStore.getSpec(s)?.status === "IN_PROGRESS",
            warnings,
          });

          const hit = removed.find((r) => r.slug === slug);
          if (opts.json) {
            console.log(
              JSON.stringify({ slug, removed: hit ?? null, warnings }),
            );
          } else if (hit) {
            console.log(`Abandoned orphan: ${hit.path} (branch ${hit.branch})`);
          } else {
            console.log(
              `No orphan found for slug: ${slug}. ` +
                `Check 'git worktree list' — it may be active (use 'worktree ` +
                `abandon <id>'), already gone, or skipped by a guard.`,
            );
            for (const w of warnings) console.log(`  ! ${w}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) console.log(JSON.stringify({ error: msg }));
          else console.error(`Error: ${msg}`);
          process.exitCode = 1;
        } finally {
          store.close();
        }
      },
    );
}
