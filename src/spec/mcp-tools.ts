/**
 * Spec MCP Tools
 *
 * Registers spec/plan workflow tools on an MCP server.
 * Currently provides:
 *   - spec_status: Current spec progress and task breakdown
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";

// --- Public API ---

export function registerSpecTools(server: McpServer, store: MemoryStore | null): void {
  const effectiveStore = store ?? new MemoryStore();
  const specStore = new SpecStore(effectiveStore);
  registerSpecStatusTool(server, specStore);
}

// --- spec_status ---

function registerSpecStatusTool(server: McpServer, specStore: SpecStore): void {
  server.tool(
    "spec_status",
    "Get the current spec/plan status for a project. Shows title, progress percentage, and remaining tasks.",
    {
      project: z.string().describe("Project path to check for active specs"),
    },
    async ({ project }) => {
      const spec = specStore.getCurrentSpec(project);

      if (!spec) {
        return { content: [{ type: "text", text: "No active spec found for this project." }] };
      }

      const totalTasks = spec.tasks.length;
      const doneTasks = spec.tasks.filter((t) => t.status === "complete").length;
      const inProgress = spec.tasks.filter((t) => t.status === "in-progress").length;
      const pending = spec.tasks.filter((t) => t.status === "pending").length;
      const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      const lines = [
        `## Current Spec: ${spec.title}`,
        "",
        `- **ID:** ${spec.id}`,
        `- **Status:** ${spec.status}`,
        `- **Type:** ${spec.type}`,
        `- **Progress:** ${doneTasks}/${totalTasks} tasks (${percent}%)`,
        `- **Plan File:** ${spec.planFile}`,
      ];

      if (totalTasks > 0) {
        lines.push("", "### Tasks");
        for (const task of spec.tasks) {
          const marker = task.status === "complete" ? "[x]" : task.status === "in-progress" ? "[~]" : "[ ]";
          lines.push(`- ${marker} Task ${task.position}: ${task.title}`);
        }
      }

      if (inProgress > 0 || pending > 0) {
        lines.push("", `**Remaining:** ${inProgress} in progress, ${pending} pending`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
