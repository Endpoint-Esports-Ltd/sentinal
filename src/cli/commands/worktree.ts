/**
 * Sentinal Worktree Command
 *
 * CLI commands for managing git worktrees.
 *
 * Usage:
 *   sentinal worktree list    [--project <path>] [--status <s>] [--json]
 *   sentinal worktree status  <id> [--json]
 *   sentinal worktree diff    <id> [--json]
 *   sentinal worktree merge   <id> [--message <msg>] [--json]
 *   sentinal worktree abandon <id> [--json]
 *   sentinal worktree cleanup [--json]
 *   sentinal worktree detect  <slug> [--project <path>] [--json]
 *   sentinal worktree create  <slug> [--project <path>] [--base <branch>] [--json]
 *   sentinal worktree sync    <slug> [-m <msg>] [--json]
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import { WorktreeStore } from "../../worktree/store.js";
import { WorktreeManager } from "../../worktree/manager.js";
import { WorktreeError, DEFAULT_WORKTREE_CONFIG } from "../../worktree/types.js";

function createManager(): { manager: WorktreeManager; wtStore: WorktreeStore; store: MemoryStore } {
  const memStore = new MemoryStore();
  const wtStore = new WorktreeStore(memStore);
  const manager = new WorktreeManager(wtStore, DEFAULT_WORKTREE_CONFIG);
  return { manager, wtStore, store: memStore };
}

function handleError(err: unknown, json?: boolean): void {
  const msg = err instanceof WorktreeError ? err.message : err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ error: msg }));
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exitCode = 1;
}

export function registerWorktreeCommand(program: Command): void {
  const wt = program
    .command("worktree")
    .description("Git worktree management — list, status, diff, merge, abandon, cleanup");

  // ─── list ─────────────────────────────────────────────────────────────

  wt.command("list")
    .description("List all worktrees")
    .option("-p, --project <path>", "Filter by project path")
    .option("-s, --status <status>", "Filter by status (active, merged, abandoned)")
    .option("--json", "Output as JSON")
    .action((opts: { project?: string; status?: string; json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        let worktrees = manager.list(opts.project ?? undefined);
        if (opts.status) {
          worktrees = worktrees.filter((w) => w.status === opts.status);
        }

        if (opts.json) {
          console.log(JSON.stringify(worktrees));
        } else if (worktrees.length === 0) {
          console.log("No worktrees found.");
        } else {
          const header = "  ID                               | Status         | Branch                         | Base";
          const sep =    "  ---------------------------------|----------------|--------------------------------|------";
          console.log(header);
          console.log(sep);
          for (const w of worktrees) {
            console.log(`  ${w.id.padEnd(33)} | ${w.status.padEnd(14)} | ${w.branchName.padEnd(30)} | ${w.baseBranch}`);
          }
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── status ───────────────────────────────────────────────────────────

  wt.command("status")
    .description("Show detailed worktree status")
    .argument("<id>", "Worktree ID")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        const result = manager.status(id);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Worktree: ${result.id}`);
          console.log(`  Status:     ${result.status}`);
          console.log(`  Branch:     ${result.branchName}`);
          console.log(`  Base:       ${result.baseBranch} (${result.baseCommit.slice(0, 8)})`);
          console.log(`  Path:       ${result.worktreePath}`);
          console.log(`  On disk:    ${result.existsOnDisk ? "yes" : "NO"}`);
          if (result.diffSummary && result.diffSummary.filesChanged > 0) {
            console.log(`  Changes:    ${result.diffSummary.filesChanged} files (+${result.diffSummary.insertions} -${result.diffSummary.deletions})`);
          }
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── diff ─────────────────────────────────────────────────────────────

  wt.command("diff")
    .description("Show diff summary for a worktree")
    .argument("<id>", "Worktree ID")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        const diff = manager.diff(id);
        if (opts.json) {
          console.log(JSON.stringify(diff));
        } else {
          console.log(`${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions}`);
          for (const f of diff.files) {
            const indicator = f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M";
            console.log(`  ${indicator} ${f.path} (+${f.insertions} -${f.deletions})`);
          }
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── merge ────────────────────────────────────────────────────────────

  wt.command("merge")
    .description("Squash merge a worktree into its base branch")
    .argument("<id>", "Worktree ID")
    .option("-m, --message <msg>", "Commit message")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { message?: string; json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        // Check conflicts first
        if (manager.hasConflicts(id)) {
          if (opts.json) {
            console.log(JSON.stringify({ error: "Merge conflicts detected", conflicts: true }));
          } else {
            console.error("Error: Merge conflicts detected. Resolve conflicts manually before merging.");
          }
          process.exitCode = 1;
          return;
        }

        const commit = manager.squashMerge(id, opts.message);
        if (opts.json) {
          console.log(JSON.stringify({ mergeCommit: commit, status: "merged" }));
        } else {
          console.log(`Merged: ${commit.slice(0, 8)}`);
          console.log(`  Worktree removed and branch deleted.`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── abandon ──────────────────────────────────────────────────────────

  wt.command("abandon")
    .description("Abandon a worktree (remove from disk, mark as abandoned)")
    .argument("<id>", "Worktree ID")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        manager.abandon(id);
        if (opts.json) {
          console.log(JSON.stringify({ id, status: "abandoned" }));
        } else {
          console.log(`Abandoned: ${id}`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── cleanup ──────────────────────────────────────────────────────────

  wt.command("cleanup")
    .description("Remove stale/orphaned worktrees")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        const cleaned = manager.cleanup();
        if (opts.json) {
          console.log(JSON.stringify({ cleaned }));
        } else {
          console.log(`Cleaned up ${cleaned} stale worktree(s).`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── detect ───────────────────────────────────────────────────────────

  wt.command("detect")
    .description("Detect an active worktree for a plan slug")
    .argument("<slug>", "Plan slug (e.g. '2026-03-12-add-auth')")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { project: string; json?: boolean }) => {
      const { wtStore, store } = createManager();
      try {
        const wt = wtStore.resolveBySlug(slug, opts.project);
        if (!wt) {
          if (opts.json) {
            console.log(JSON.stringify({ found: false }));
          } else {
            console.log(`No worktree found for: ${slug}`);
          }
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({
            path: wt.worktreePath,
            branch: wt.branchName,
            baseBranch: wt.baseBranch,
            status: wt.status,
          }));
        } else {
          console.log(`Worktree found: ${wt.worktreePath} (branch: ${wt.branchName})`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── create ───────────────────────────────────────────────────────────

  wt.command("create")
    .description("Create a new worktree for a plan slug")
    .argument("<slug>", "Plan slug (e.g. '2026-03-12-add-auth')")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option("-b, --base <branch>", "Base branch to create from (auto-detected if omitted)")
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { project: string; base?: string; json?: boolean }) => {
      const { manager, store } = createManager();
      try {
        const wt = manager.create(slug, opts.project, opts.base);
        if (opts.json) {
          console.log(JSON.stringify({
            path: wt.worktreePath,
            branch: wt.branchName,
            baseBranch: wt.baseBranch,
          }));
        } else {
          console.log(`Created worktree: ${wt.worktreePath} (branch: ${wt.branchName})`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });

  // ─── sync ─────────────────────────────────────────────────────────────

  wt.command("sync")
    .description("Squash-merge a worktree by plan slug back to its base branch")
    .argument("<slug>", "Plan slug (e.g. '2026-03-12-add-auth')")
    .option("-m, --message <msg>", "Commit message")
    .option("-p, --project <path>", "Project path", process.cwd())
    .option("--json", "Output as JSON")
    .action((slug: string, opts: { message?: string; project: string; json?: boolean }) => {
      const { manager, wtStore, store } = createManager();
      try {
        const wt = wtStore.resolveBySlug(slug, opts.project);
        if (!wt) {
          if (opts.json) {
            console.log(JSON.stringify({ error: `No worktree found for: ${slug}` }));
          } else {
            console.error(`Error: No worktree found for: ${slug}`);
          }
          process.exitCode = 1;
          return;
        }

        if (manager.hasConflicts(wt.id)) {
          if (opts.json) {
            console.log(JSON.stringify({ error: "Merge conflicts detected", conflicts: true }));
          } else {
            console.error("Error: Merge conflicts detected. Resolve conflicts manually before syncing.");
          }
          process.exitCode = 1;
          return;
        }

        const commit = manager.squashMerge(wt.id, opts.message);
        if (opts.json) {
          console.log(JSON.stringify({ commit, branch: wt.branchName, baseBranch: wt.baseBranch }));
        } else {
          console.log(`Merged: ${commit.slice(0, 8)} (branch: ${wt.branchName} → ${wt.baseBranch})`);
        }
      } catch (err) {
        handleError(err, opts.json);
      } finally {
        store.close();
      }
    });
}
