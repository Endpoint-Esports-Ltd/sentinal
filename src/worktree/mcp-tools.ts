/**
 * Worktree MCP Tools
 *
 * Registers worktree management tools on an MCP server.
 * Provides:
 *   - worktree_detect: Find worktree by plan slug (self-healing: marks stale entries abandoned)
 *   - worktree_create: Create worktree for a plan slug
 *   - worktree_diff: Get diff summary for a worktree
 *   - worktree_sync: Squash-merge a worktree
 *   - worktree_abandon: Abandon a worktree by slug (remove from disk + mark abandoned)
 *   - worktree_cleanup: Clean up all stale worktrees whose directories no longer
 *     exist — registered from the sibling `cleanup-mcp-tool.ts`, which was split
 *     out for length and because it is the only tool here that deletes anything
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import {
  DEFAULT_WORKTREE_CONFIG,
  type ResolvedWorktree,
  type WorktreeConfig,
} from "./types.js";
import type { SidecarClient } from "../sidecar/client.js";
import { formatSlot } from "./slots.js";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { registerWorktreeCleanupTool } from "./cleanup-mcp-tool.js";

/**
 * Append non-fatal warnings to a Markdown tool response.
 *
 * ⛔ These must reach the model. A worktree that was created but NOT seeded
 * looks identical to a seeded one from the outside, and the documented failure
 * mode (issue #2) is an agent filling the gap by copying the repo-root `.env`
 * — which is how a worktree ends up pointed at live databases.
 */
function withWarnings(lines: string[], warnings: string[]): string[] {
  if (warnings.length === 0) return lines;
  return [...lines, "", "### Warnings", "", ...warnings.map((w) => `- ${w}`)];
}

// --- Public API ---

export interface WorktreeToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
  /**
   * The manager config, carrying the injected runtime dependencies
   * (`sharedResourcesFor`, `stopOwnedRuntime`, `ownsLiveRuntime`).
   *
   * ⛔ **Threaded down from `src/mcp/server.ts` rather than built here.** This
   * file lives inside `src/worktree/`, which may import NOTHING from
   * `src/runtime/` (`src/runtime/no-module-cycle.test.ts`) — so it cannot call
   * `runtimeWorktreeConfig()` itself. Omitting it yields the inert defaults,
   * which is exactly the pre-Phase-4 behaviour.
   */
  worktreeConfig?: WorktreeConfig;
}

export function registerWorktreeTools(
  server: McpServer,
  deps: WorktreeToolsDeps | MemoryStore | null,
): void {
  // Backwards-compat: bare MemoryStore or null
  let client: SidecarClient | null = null;
  let effectiveStore: MemoryStore;
  let worktreeConfig: WorktreeConfig = DEFAULT_WORKTREE_CONFIG;

  if (
    deps &&
    ("client" in deps || "store" in deps || "worktreeConfig" in deps)
  ) {
    const d = deps as WorktreeToolsDeps;
    client = d.client ?? null;
    effectiveStore = d.store ?? new MemoryStore();
    worktreeConfig = d.worktreeConfig ?? DEFAULT_WORKTREE_CONFIG;
  } else {
    effectiveStore = (deps as MemoryStore | null) ?? new MemoryStore();
  }

  const wtStore = new WorktreeStore(effectiveStore);
  const manager = new WorktreeManager(wtStore, worktreeConfig);

  registerWorktreeDetectTool(server, client, manager);
  registerWorktreeCreateTool(server, manager);
  registerWorktreeDiffTool(server, client, manager);
  registerWorktreeSyncTool(server, client, manager);
  registerWorktreeAbandonTool(server, client, manager);
  registerWorktreeCleanupTool(server, client, manager, effectiveStore);
}

// --- worktree_detect ---

function registerWorktreeDetectTool(
  server: McpServer,
  client: SidecarClient | null,
  manager: WorktreeManager,
): void {
  server.tool(
    "worktree_detect",
    "Detect an active worktree for a plan slug. Returns path, branch, status, or 'not found'. Self-healing: if the worktree directory no longer exists on disk, automatically marks it as abandoned.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
    },
    async ({ plan_slug, project }) => {
      try {
        const projectPath = project ?? process.cwd();

        // Both modes self-heal: the sidecar route and direct manager path
        // reconcile the index against on-disk git worktrees, and BOTH surface
        // the seeding/slot warnings that reconcile produced — the sidecar
        // returns them on the response, the direct path fills the collector.
        const warnings: string[] = [];
        const wt: ResolvedWorktree | null = client
          ? await client.resolveWorktreeBySlug(plan_slug, projectPath)
          : manager.resolveWithReconcile(plan_slug, projectPath, warnings);
        if (wt?.warnings) warnings.push(...wt.warnings);

        if (!wt) {
          return mcpText(`No active worktree found for slug: ${plan_slug}`);
        }

        const lines = [
          `## Worktree: ${plan_slug}`,
          "",
          `- **Path:** ${wt.worktreePath}`,
          `- **Branch:** ${wt.branchName}`,
          `- **Base Branch:** ${wt.baseBranch}`,
          `- **Status:** ${wt.status}`,
          `- **Slot:** ${formatSlot(wt.slot)}`,
          `- **ID:** ${wt.id}`,
        ];

        return mcpText(withWarnings(lines, warnings).join("\n"));
      } catch (err) {
        return mcpError("Error detecting worktree", err);
      }
    },
  );
}

// --- worktree_create ---

function registerWorktreeCreateTool(
  server: McpServer,
  manager: WorktreeManager,
): void {
  server.tool(
    "worktree_create",
    "Create a new git worktree for a plan slug. Returns path, branch, and base branch.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      base_branch: z
        .string()
        .optional()
        .describe("Base branch to create from (auto-detected if omitted)"),
    },
    async ({ plan_slug, project, base_branch }) => {
      try {
        const projectPath = project ?? process.cwd();
        const warnings: string[] = [];
        const wt = manager.create(
          plan_slug,
          projectPath,
          base_branch,
          warnings,
        );

        const lines = [
          `## Created Worktree`,
          "",
          `- **ID:** ${wt.id}`,
          `- **Path:** ${wt.worktreePath}`,
          `- **Branch:** ${wt.branchName}`,
          `- **Base Branch:** ${wt.baseBranch}`,
          `- **Slot:** ${formatSlot(wt.slot)}`,
        ];

        return mcpText(withWarnings(lines, warnings).join("\n"));
      } catch (err) {
        return mcpError("Error creating worktree", err);
      }
    },
  );
}

// --- worktree_diff ---

function registerWorktreeDiffTool(
  server: McpServer,
  client: SidecarClient | null,
  manager: WorktreeManager,
): void {
  server.tool(
    "worktree_diff",
    "Get a diff summary for a worktree identified by plan slug. Shows files changed, insertions, and deletions.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
    },
    async ({ plan_slug, project }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = client
          ? await client.resolveWorktreeBySlug(plan_slug, projectPath)
          : manager.resolveWithReconcile(plan_slug, projectPath);

        if (!wt) {
          return mcpText(`No active worktree found for slug: ${plan_slug}`);
        }

        const diff = manager.diff(wt.id);

        const lines = [
          `## Diff: ${plan_slug}`,
          "",
          `- **Files Changed:** ${diff.filesChanged}`,
          `- **Insertions:** +${diff.insertions}`,
          `- **Deletions:** -${diff.deletions}`,
        ];

        if (diff.files.length > 0) {
          lines.push("", "### Files");
          for (const f of diff.files) {
            lines.push(
              `- ${f.status} ${f.path} (+${f.insertions}/-${f.deletions})`,
            );
          }
        }

        return mcpText(lines.join("\n"));
      } catch (err) {
        return mcpError("Error getting diff", err);
      }
    },
  );
}

// --- worktree_sync ---

function registerWorktreeSyncTool(
  server: McpServer,
  client: SidecarClient | null,
  manager: WorktreeManager,
): void {
  server.tool(
    "worktree_sync",
    "Squash-merge a worktree back to its base branch. WARNING: This is destructive — the worktree is removed after merge.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      message: z
        .string()
        .optional()
        .describe("Custom commit message for the squash merge"),
    },
    async ({ plan_slug, project, message }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = client
          ? await client.resolveWorktreeBySlug(plan_slug, projectPath)
          : manager.resolveWithReconcile(plan_slug, projectPath);

        if (!wt) {
          return mcpText(`No active worktree found for slug: ${plan_slug}`);
        }

        // Check for conflicts first
        if (manager.hasConflicts(wt.id)) {
          return mcpText(
            `Error: Worktree has merge conflicts. Resolve them before syncing.`,
          );
        }

        const commitHash = await manager.squashMerge(wt.id, message);
        return mcpText(
          `Merged: ${commitHash} (branch: ${wt.branchName} → ${wt.baseBranch})`,
        );
      } catch (err) {
        return mcpError("Error syncing worktree", err);
      }
    },
  );
}

// --- worktree_abandon ---

function registerWorktreeAbandonTool(
  server: McpServer,
  client: SidecarClient | null,
  manager: WorktreeManager,
): void {
  server.tool(
    "worktree_abandon",
    "Abandon a worktree — remove from disk and mark as abandoned. WARNING: Uncommitted changes will be lost.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
    },
    async ({ plan_slug, project }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = client
          ? await client.resolveWorktreeBySlug(plan_slug, projectPath)
          : manager.resolveWithReconcile(plan_slug, projectPath);

        if (!wt) {
          return mcpText(`No active worktree found for slug: ${plan_slug}`);
        }

        if (client) {
          await client.abandonWorktree(wt.id);
        } else {
          await manager.abandon(wt.id);
        }

        return mcpText(
          `Worktree abandoned: ${wt.branchName} (was at ${wt.worktreePath})`,
        );
      } catch (err) {
        return mcpError("Error abandoning worktree", err);
      }
    },
  );
}
