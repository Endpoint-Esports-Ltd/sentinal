/**
 * `worktree_cleanup` — the one MCP tool that deletes directories.
 *
 * Split out of `mcp-tools.ts` when the guard-3 fix and guard-5 warning
 * surfacing pushed that file past the 400-line warn (same precedent as
 * `src/runtime/lifecycle-mcp-tools.ts`, split off `runtime/mcp-tools.ts` for
 * the same reason). `registerWorktreeTools` still calls this, so the
 * registration chain and `src/mcp/server.ts` are unchanged.
 *
 * Cohesion, not merely line count: this is the only worktree tool whose failure
 * mode is *deleting the wrong thing*, and the inputs to all five guards that
 * prevent that are assembled here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeManager } from "./manager.js";
import type { SidecarClient } from "../sidecar/client.js";
import { mcpText, mcpError } from "../mcp/helpers.js";

export function registerWorktreeCleanupTool(
  server: McpServer,
  client: SidecarClient | null,
  manager: WorktreeManager,
  store: MemoryStore,
): void {
  server.tool(
    "worktree_cleanup",
    "Clean up stale worktrees. By default removes only worktrees whose " +
      "directory no longer exists. With force=true, ALSO removes orphaned " +
      "sentinal worktrees whose directory still exists (from crashed/abandoned " +
      "sessions) — DESTRUCTIVE: this deletes worktree directories and branches. " +
      "It never removes a worktree whose plan is IN_PROGRESS, the current " +
      "worktree, a non-sentinal branch, one outside the project, or one that " +
      "still owns running processes.",
    {
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Also remove orphaned worktrees whose directory still exists " +
            "(DESTRUCTIVE — deletes dirs + branches). Default false.",
        ),
      current_worktree: z
        .string()
        .optional()
        .describe(
          "The caller's own worktree directory — never removed. Defaults to this process's cwd.",
        ),
    },
    async ({ project, force, current_worktree }) => {
      try {
        const projectPath = project ?? process.cwd();
        // ⛔ Guard 3 ("never the caller's current worktree") was DEAD in
        // production until this was threaded: neither entry point sent it, so
        // `--force` could delete the very directory the caller was working in.
        // `process.cwd()` is the right default HERE and only here — the MCP
        // server is spawned in the agent's working directory, whereas the
        // sidecar is a long-lived process with an unrelated cwd and therefore
        // reads the value off the wire instead.
        const currentWorktree = current_worktree ?? process.cwd();
        const warnings: string[] = [];
        let cleaned: number;

        if (client) {
          const result = await client.cleanupWorktrees(projectPath, {
            force: force === true,
            currentWorktree,
          });
          cleaned = result.cleaned;
          // Widened at the point of use: the sidecar returns guard-5 skips
          // alongside the count, but `client.ts` stays untouched — D5 adds no
          // route and no new wire field, and guard 5's input is derived
          // server-side from each worktree's own pidfile.
          warnings.push(
            ...((result as { warnings?: string[] }).warnings ?? []),
          );
        } else {
          // Direct path: build the IN_PROGRESS guard from the spec store so a
          // running plan's worktree is never force-removed even offline.
          const specStore = new SpecStore(store);
          cleaned = manager.cleanup({
            force: force === true,
            projectPath,
            currentWorktree,
            isPlanActive: (slug) =>
              specStore.getSpec(slug)?.status === "IN_PROGRESS",
            warnings,
          });
        }

        // ⛔ Never report a bare count when something was skipped. "Cleaned up 0
        // stale worktrees." reads as "there was nothing to do", and the obvious
        // next move for an agent reading that is to delete the directory by
        // hand — the exact orphan guard 5 just prevented.
        const summary = `Cleaned up ${cleaned} stale worktree${cleaned === 1 ? "" : "s"}.`;
        return mcpText(
          warnings.length > 0
            ? `${summary}\n\nSkipped:\n${warnings.map((w) => `  - ${w}`).join("\n")}`
            : summary,
        );
      } catch (err) {
        return mcpError("Error cleaning up worktrees", err);
      }
    },
  );
}
