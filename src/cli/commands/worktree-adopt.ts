/**
 * `sentinal worktree ensure` — create-or-ADOPT a worktree (orca Task 9, D4).
 *
 * The CLI face of the `worktree_ensure` MCP tool. Both call `ensureWorktree`
 * and build their output from the same {@link ensureReport}, so `--json` is
 * byte-for-byte the tool's machine-readable result.
 *
 * Split out of `worktree.ts` (394 lines) for length, like `worktree-cleanup.ts`.
 *
 * ⛔ `runtimeWorktreeConfig()` is what supplies `runSetup` (the contract's
 * once-per-worktree `setup`) and the seeding token check; a bare default config
 * would adopt without either.
 */

import type { Command } from "commander";
import { MemoryStore } from "../../memory/store.js";
import { WorktreeStore } from "../../worktree/store.js";
import { ensureWorktree } from "../../worktree/adopt.js";
import {
  ensureInputError,
  ensureReport,
  formatSetupLine,
  type EnsureReport,
} from "../../worktree/adopt-mcp-tool.js";
import type { WorktreeConfig, WorktreeOwner } from "../../worktree/types.js";
import { runtimeWorktreeConfig } from "../../runtime/worktree-deps.js";

/** Injectable for tests; production opens the real DB and runtime config. */
export interface WorktreeAdoptDeps {
  openStore?: () => MemoryStore;
  config?: () => WorktreeConfig;
}

interface EnsureOpts {
  path?: string;
  base?: string;
  owner?: string;
  seed: boolean;
  takeover?: boolean;
  project: string;
  json?: boolean;
}

const OWNERS: readonly WorktreeOwner[] = ["sentinal", "external"];

function printText(r: EnsureReport): void {
  const label = r.action[0]!.toUpperCase() + r.action.slice(1);
  console.log(`${label}: ${r.id}`);
  console.log(`  Path:   ${r.path}`);
  console.log(`  Branch: ${r.branch} (base ${r.base})`);
  console.log(`  Slot:   ${r.slotNote}`);
  console.log(`  Owner:  ${r.owner}`);
  console.log(`  ${formatSetupLine(r.setup).replace("**Setup:**", "Setup: ")}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
}

function fail(msg: string, json?: boolean): void {
  if (json) console.log(JSON.stringify({ error: msg }));
  else console.error(`Error: ${msg}`);
  process.exitCode = 1;
}

export function registerWorktreeAdoptCommands(
  wt: Command,
  deps: WorktreeAdoptDeps = {},
): void {
  wt.command("ensure")
    .description(
      "Create or ADOPT the worktree for a plan slug (slot, seeding, setup). " +
        "External worktrees are never deleted by Sentinal.",
    )
    .argument("<slug>", "Plan slug, e.g. '2026-03-12-add-auth'")
    .option("--path <dir>", "Existing linked worktree of the repo to adopt")
    .option("--base <branch>", "Base branch (required with --owner external)")
    .option("--owner <owner>", "sentinal|external (default sentinal)")
    .option("--no-seed", "Do not seed per-slot config into an adopted worktree")
    .option(
      "--takeover",
      "Adopt an existing --path as owner sentinal (Sentinal may later delete it)",
    )
    .option("-p, --project <path>", "Any checkout of the repo", process.cwd())
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: EnsureOpts) => {
      const owner = (opts.owner ?? "sentinal") as WorktreeOwner;
      if (!OWNERS.includes(owner)) {
        fail(
          `--owner must be sentinal|external (got "${opts.owner}").`,
          opts.json,
        );
        return;
      }
      const refusal = ensureInputError({
        owner,
        path: opts.path,
        base: opts.base,
      });
      if (refusal) {
        fail(refusal, opts.json);
        return;
      }

      const store = (deps.openStore ?? (() => new MemoryStore()))();
      try {
        const warnings: string[] = [];
        const ensured = await ensureWorktree(
          new WorktreeStore(store),
          (deps.config ?? (() => runtimeWorktreeConfig()))(),
          {
            slug,
            project: opts.project,
            path: opts.path,
            base: opts.base,
            owner,
            seed: opts.seed,
            takeover: opts.takeover,
          },
          warnings,
        );
        const report = ensureReport(ensured, warnings);
        if (opts.json) console.log(JSON.stringify(report));
        else printText(report);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), opts.json);
      } finally {
        store.close();
      }
    });
}
