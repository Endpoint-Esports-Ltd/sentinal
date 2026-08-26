/**
 * Spec Workflow-Context MCP Tools
 *
 * The read-only "where am I?" half of the spec domain. Provides:
 *   - spec_config: Read spec workflow toggle env vars
 *   - spec_status: Current spec progress and task breakdown
 *   - spec_init:   Compound workflow context (config + active plan + tasks)
 *
 * Split out of `./mcp-tools.ts` purely for length — that file sat at 681 lines,
 * over the 600-line hard block, which made it uneditable. `registerSpecTools`
 * remains the single entry point and calls `registerSpecStatusTools`, so
 * `src/mcp/server.ts` needs no change. Same precedent as
 * `src/runtime/lifecycle-mcp-tools.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText } from "../mcp/helpers.js";
import { findActivePlan } from "./detect.js";
import type { SpecStore } from "./store.js";
import type { SidecarClient } from "../sidecar/client.js";
import type { SpecTask } from "./types.js";

// --- Public API ---

export function registerSpecStatusTools(
  server: McpServer,
  client: SidecarClient | null,
  specStore: SpecStore | null,
): void {
  registerSpecConfigTool(server);
  registerSpecStatusTool(server, client, specStore);
  registerSpecInitTool(server, client, specStore);
}

// --- spec_config ---

/** Shared by spec_config and spec_init, which render the same block. */
export const CONFIG_KEYS = [
  { env: "SENTINAL_PLAN_QUESTIONS_ENABLED", label: "questions_enabled" },
  { env: "SENTINAL_PLAN_REVIEWER_ENABLED", label: "plan_reviewer_enabled" },
  { env: "SENTINAL_PLAN_APPROVAL_ENABLED", label: "approval_enabled" },
  { env: "SENTINAL_SPEC_REVIEWER_ENABLED", label: "spec_reviewer_enabled" },
  { env: "SENTINAL_WORKTREE_ENABLED", label: "worktree_enabled" },
  { env: "SENTINAL_SESSION_ID", label: "session_id" },
] as const;

function registerSpecConfigTool(server: McpServer): void {
  server.tool(
    "spec_config",
    "Get all spec workflow toggle configuration from SENTINAL_* environment variables.",
    {},
    async () => {
      const lines = ["## Spec Workflow Configuration", ""];

      for (const { env, label } of CONFIG_KEYS) {
        const value = process.env[env];
        let display: string;
        if (value === undefined || value === "") {
          display =
            label === "session_id" ? "unset" : "unset (default: enabled)";
        } else if (value === "false") {
          display = `${value} (disabled)`;
        } else {
          display = value;
        }
        lines.push(`- **${label}:** ${display}`);
      }

      return mcpText(lines.join("\n"));
    },
  );
}

// --- spec_status ---

function registerSpecStatusTool(
  server: McpServer,
  client: SidecarClient | null,
  specStore: SpecStore | null,
): void {
  server.tool(
    "spec_status",
    "Get the current spec/plan status for a project. Shows title, progress percentage, and remaining tasks.",
    {
      project: z.string().describe("Project path to check for active specs"),
    },
    async ({ project }) => {
      const spec = client
        ? await client.getCurrentSpec(project)
        : specStore!.getCurrentSpec(project);

      if (!spec) {
        return mcpText("No active spec found for this project.");
      }

      const totalTasks = spec.tasks.length;
      const doneTasks = spec.tasks.filter(
        (t) => t.status === "complete",
      ).length;
      const inProgress = spec.tasks.filter(
        (t) => t.status === "in-progress",
      ).length;
      const pending = spec.tasks.filter((t) => t.status === "pending").length;
      const percent =
        totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

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
          const marker =
            task.status === "complete"
              ? "[x]"
              : task.status === "in-progress"
                ? "[~]"
                : "[ ]";
          lines.push(`- ${marker} Task ${task.position}: ${task.title}`);
        }
      }

      if (inProgress > 0 || pending > 0) {
        lines.push(
          "",
          `**Remaining:** ${inProgress} in progress, ${pending} pending`,
        );
      }

      return mcpText(lines.join("\n"));
    },
  );
}

// --- spec_init (compound workflow context) ---

function registerSpecInitTool(
  server: McpServer,
  client: SidecarClient | null,
  specStore: SpecStore | null,
): void {
  server.tool(
    "spec_init",
    "Get all workflow context in a single call: active plan state, config toggles, current task, and remaining work. Use at the start of any spec workflow to avoid multiple file reads.",
    {
      project: z.string().describe("Project path to check for active specs"),
    },
    async ({ project }) => {
      const lines: string[] = ["## Spec Workflow Context", ""];

      // --- Configuration ---
      lines.push("### Configuration", "");
      for (const { env, label } of CONFIG_KEYS) {
        const value = process.env[env];
        let display: string;
        if (value === undefined || value === "") {
          display =
            label === "session_id" ? "unset" : "unset (default: enabled)";
        } else if (value === "false") {
          display = `${value} (disabled)`;
        } else {
          display = value;
        }
        lines.push(`- **${label}:** ${display}`);
      }
      lines.push("");

      // --- Active Plan ---
      const active = findActivePlan(project);
      if (!active) {
        lines.push("### Active Plan", "", "No active plan found.", "");
        return mcpText(lines.join("\n"));
      }

      const { filePath, spec } = active;
      const tasks: SpecTask[] = spec.tasks;
      const totalTasks = tasks.length;
      const doneTasks = tasks.filter((t) => t.status === "complete").length;
      const percent =
        totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      lines.push(
        "### Active Plan",
        "",
        `- **Title:** ${spec.title}`,
        `- **Status:** ${spec.status}`,
        `- **Type:** ${spec.type}`,
        `- **Approved:** ${spec.approved ? "Yes" : "No"}`,
        `- **Progress:** ${doneTasks}/${totalTasks} tasks (${percent}%)`,
        `- **Plan File:** ${filePath}`,
        "",
      );

      // --- Current Task ---
      const currentTask =
        tasks.find((t) => t.status === "in-progress") ??
        tasks.find((t) => t.status === "pending") ??
        null;

      if (currentTask) {
        lines.push(
          "### Current Task",
          "",
          `- **Task ${currentTask.position}:** ${currentTask.title} (${currentTask.status})`,
          "",
        );
      }

      // --- Remaining Tasks ---
      const remainingTasks = tasks.filter((t) => t.status !== "complete");
      if (remainingTasks.length > 0) {
        lines.push("### Remaining Tasks", "");
        for (const task of remainingTasks) {
          const marker = task.status === "in-progress" ? "[~]" : "[ ]";
          lines.push(`- ${marker} Task ${task.position}: ${task.title}`);
        }
        lines.push("");
      }

      return mcpText(lines.join("\n"));
    },
  );
}
