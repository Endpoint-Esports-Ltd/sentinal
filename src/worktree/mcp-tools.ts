/**
 * Worktree MCP Tools
 *
 * Registers worktree management tools on an MCP server.
 * Provides:
 *   - worktree_detect: Find worktree by plan slug
 *   - worktree_create: Create worktree for a plan slug
 *   - worktree_diff: Get diff summary for a worktree
 *   - worktree_sync: Squash-merge a worktree
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "../memory/store.js";
import { WorktreeStore } from "./store.js";
import { WorktreeManager } from "./manager.js";
import { DEFAULT_WORKTREE_CONFIG } from "./types.js";

// --- Public API ---

export function registerWorktreeTools(server: McpServer, store: MemoryStore | null): void {
  const effectiveStore = store ?? new MemoryStore();
  const wtStore = new WorktreeStore(effectiveStore);
  const manager = new WorktreeManager(wtStore, DEFAULT_WORKTREE_CONFIG);

  registerWorktreeDetectTool(server, wtStore);
  registerWorktreeCreateTool(server, manager);
  registerWorktreeDiffTool(server, wtStore, manager);
  registerWorktreeSyncTool(server, wtStore, manager);
}

// --- worktree_detect ---

function registerWorktreeDetectTool(server: McpServer, wtStore: WorktreeStore): void {
  server.tool(
    "worktree_detect",
    "Detect an active worktree for a plan slug. Returns path, branch, status, or 'not found'.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
    },
    async ({ plan_slug, project }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = wtStore.resolveBySlug(plan_slug, projectPath);

        if (!wt) {
          return { content: [{ type: "text" as const, text: `No active worktree found for slug: ${plan_slug}` }] };
        }

        const lines = [
          `## Worktree: ${plan_slug}`,
          "",
          `- **Path:** ${wt.worktreePath}`,
          `- **Branch:** ${wt.branchName}`,
          `- **Base Branch:** ${wt.baseBranch}`,
          `- **Status:** ${wt.status}`,
          `- **ID:** ${wt.id}`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error detecting worktree: ${msg}` }] };
      }
    },
  );
}

// --- worktree_create ---

function registerWorktreeCreateTool(server: McpServer, manager: WorktreeManager): void {
  server.tool(
    "worktree_create",
    "Create a new git worktree for a plan slug. Returns path, branch, and base branch.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      base_branch: z.string().optional().describe("Base branch to create from (auto-detected if omitted)"),
    },
    async ({ plan_slug, project, base_branch }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = manager.create(plan_slug, projectPath, base_branch);

        const lines = [
          `## Created Worktree`,
          "",
          `- **Path:** ${wt.worktreePath}`,
          `- **Branch:** ${wt.branchName}`,
          `- **Base Branch:** ${wt.baseBranch}`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error creating worktree: ${msg}` }] };
      }
    },
  );
}

// --- worktree_diff ---

function registerWorktreeDiffTool(server: McpServer, wtStore: WorktreeStore, manager: WorktreeManager): void {
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
        const wt = wtStore.resolveBySlug(plan_slug, projectPath);

        if (!wt) {
          return { content: [{ type: "text" as const, text: `No active worktree found for slug: ${plan_slug}` }] };
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
            lines.push(`- ${f.status} ${f.path} (+${f.insertions}/-${f.deletions})`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error getting diff: ${msg}` }] };
      }
    },
  );
}

// --- worktree_sync ---

function registerWorktreeSyncTool(server: McpServer, wtStore: WorktreeStore, manager: WorktreeManager): void {
  server.tool(
    "worktree_sync",
    "Squash-merge a worktree back to its base branch. WARNING: This is destructive — the worktree is removed after merge.",
    {
      plan_slug: z.string().describe("Plan slug (e.g. '2026-03-12-add-auth')"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      message: z.string().optional().describe("Custom commit message for the squash merge"),
    },
    async ({ plan_slug, project, message }) => {
      try {
        const projectPath = project ?? process.cwd();
        const wt = wtStore.resolveBySlug(plan_slug, projectPath);

        if (!wt) {
          return { content: [{ type: "text" as const, text: `No active worktree found for slug: ${plan_slug}` }] };
        }

        // Check for conflicts first
        if (manager.hasConflicts(wt.id)) {
          return { content: [{ type: "text" as const, text: `Error: Worktree has merge conflicts. Resolve them before syncing.` }] };
        }

        const commitHash = manager.squashMerge(wt.id, message);
        const text = `Merged: ${commitHash} (branch: ${wt.branchName} → ${wt.baseBranch})`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error syncing worktree: ${msg}` }] };
      }
    },
  );
}
