/**
 * Spec Activity MCP Tools
 *
 * The recorded-activity half of the spec domain — everything that reads or
 * writes the workflow's own audit trail rather than the plan file. Provides:
 *   - spec_notify:  Create a notification in SQLite (dashboard-visible)
 *   - spec_events:  Read spec lifecycle event history
 *   - spec_metrics: Plan + per-task timing derived from that history
 *
 * Split out of `./mcp-tools.ts` purely for length — that file sat at 681 lines,
 * over the 600-line hard block, which made it uneditable. `registerSpecTools`
 * remains the single entry point and calls `registerSpecEventsTools`, so
 * `src/mcp/server.ts` needs no change. Same precedent as
 * `src/runtime/lifecycle-mcp-tools.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import type { MemoryStore } from "../memory/store.js";
import { findActivePlan } from "./detect.js";
import type { SpecStore } from "./store.js";
import type { SidecarClient } from "../sidecar/client.js";
import { requiredEnum } from "../utils/schema.js";

// --- Public API ---

export function registerSpecEventsTools(
  server: McpServer,
  client: SidecarClient | null,
  memoryStore: MemoryStore | null,
  specStore: SpecStore | null,
): void {
  registerSpecNotifyTool(server, client, memoryStore);
  registerSpecEventsTool(server, client, memoryStore);
  registerSpecMetricsTool(server, client, specStore);
}

// --- spec_notify ---

function registerSpecNotifyTool(
  server: McpServer,
  client: SidecarClient | null,
  memoryStore: MemoryStore | null,
): void {
  server.tool(
    "spec_notify",
    "Create a notification in the SQLite store. Useful for recording workflow events visible in the dashboard.",
    {
      type: requiredEnum(
        ["info", "warning", "error", "success"],
        "Notification type",
      ),
      title: z.string().describe("Short notification title"),
      message: z.string().optional().describe("Longer notification message"),
      spec_id: z.string().optional().describe("Associated spec ID"),
    },
    async ({ type, title, message, spec_id }) => {
      try {
        if (client) {
          await client.insertNotification({
            type,
            title,
            message: message ?? undefined,
            specId: spec_id ?? undefined,
          });
        } else {
          memoryStore!.insertNotification({
            type,
            title,
            message: message ?? null,
            specId: spec_id ?? null,
          });
        }
        return mcpText(`Notification created: ${title}`);
      } catch (err) {
        return mcpError("Error creating notification", err);
      }
    },
  );
}

// --- spec_events ---

function registerSpecEventsTool(
  server: McpServer,
  client: SidecarClient | null,
  memoryStore: MemoryStore | null,
): void {
  server.tool(
    "spec_events",
    "Get recent spec lifecycle events (phase changes, task updates, TDD cycles, etc.) for a spec.",
    {
      spec_id: z.string().describe("Spec ID to get events for"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of events to return (default 20)"),
    },
    async ({ spec_id, limit }) => {
      try {
        const events = client
          ? await client.getSpecEvents(spec_id, limit ?? 20)
          : memoryStore!.getSpecEvents(spec_id, limit ?? 20);

        if (events.length === 0) {
          return mcpText(`No events found for spec: ${spec_id}`);
        }

        const lines = [`## Events for ${spec_id}`, ""];
        for (const event of events) {
          const time = new Date(event.timestamp).toISOString();
          const details = JSON.stringify(event.details);
          lines.push(`- **${event.eventType}** (${time}): ${details}`);
        }

        return mcpText(lines.join("\n"));
      } catch (err) {
        return mcpError("Error getting events", err);
      }
    },
  );
}

// --- spec_metrics (plan + task timing) ---

function registerSpecMetricsTool(
  server: McpServer,
  client: SidecarClient | null,
  specStore: SpecStore | null,
): void {
  server.tool(
    "spec_metrics",
    "Get performance metrics for a spec: plan duration, per-task timing, and velocity data. Use for tracking implementation speed.",
    {
      project: z.string().describe("Project path to check for active specs"),
      spec_id: z
        .string()
        .optional()
        .describe("Specific spec ID (defaults to active spec)"),
    },
    async ({ project, spec_id }) => {
      const active = findActivePlan(project);
      if (!active && !spec_id) {
        return mcpText(
          "No active spec found. Provide a spec_id to query a specific plan.",
        );
      }

      const targetId = spec_id ?? active?.spec.id;
      if (!targetId || (!client && !specStore)) {
        return mcpText("No spec found.");
      }

      // Client-first (production/sidecar mode); direct specStore fallback.
      let rawSpec: {
        title: string;
        status: string;
        startedAt: number | null;
        completedAt: number | null;
      } | null;
      let rawTasks: Array<{
        position: number;
        title: string;
        status: string;
        startedAt: number | null;
        completedAt: number | null;
      }>;
      try {
        if (client) {
          const data = await client.getSpecMetrics(targetId);
          rawSpec = data.spec;
          rawTasks = data.tasks;
        } else {
          rawSpec = specStore!.getSpecTiming(targetId);
          rawTasks = rawSpec ? specStore!.getTaskTiming(targetId) : [];
        }
      } catch (err) {
        return mcpError("Error getting spec metrics", err);
      }

      if (!rawSpec) {
        return mcpText(`Spec not found: ${targetId}`);
      }

      const lines: string[] = [`## Spec Metrics: ${rawSpec.title}`, ""];

      // Plan timing
      if (rawSpec.startedAt) {
        const startDate = new Date(rawSpec.startedAt).toISOString();
        lines.push("### Plan Timing", "");
        lines.push(`- **Started:** ${startDate}`);
        if (rawSpec.completedAt) {
          const endDate = new Date(rawSpec.completedAt).toISOString();
          const durationMs = rawSpec.completedAt - rawSpec.startedAt;
          const durationMin = Math.round(durationMs / 60000);
          const hours = Math.floor(durationMin / 60);
          const mins = durationMin % 60;
          const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
          lines.push(`- **Completed:** ${endDate}`);
          lines.push(`- **Duration:** ${durationStr}`);
        } else {
          const elapsedMs = Date.now() - rawSpec.startedAt;
          const elapsedMin = Math.round(elapsedMs / 60000);
          lines.push(
            `- **Status:** ${rawSpec.status} (${elapsedMin}m elapsed)`,
          );
        }
        lines.push("");
      }

      // Task timing
      const tasksWithTiming = rawTasks.filter(
        (t) => t.startedAt || t.completedAt,
      );

      if (tasksWithTiming.length > 0) {
        lines.push("### Task Timing", "");
        lines.push("| Task | Status | Duration |");
        lines.push("|------|--------|----------|");

        let totalDuration = 0;
        let longestDuration = 0;
        let longestTask = "";

        for (const task of rawTasks) {
          if (task.startedAt && task.completedAt) {
            const dur = task.completedAt - task.startedAt;
            const durMin = Math.round(dur / 60000);
            totalDuration += dur;
            if (dur > longestDuration) {
              longestDuration = dur;
              longestTask = `Task ${task.position}`;
            }
            lines.push(
              `| ${task.position}: ${task.title} | ${task.status} | ${durMin}m |`,
            );
          } else if (task.startedAt) {
            const elapsed = Math.round((Date.now() - task.startedAt) / 60000);
            lines.push(
              `| ${task.position}: ${task.title} | ${task.status} | ${elapsed}m (in progress) |`,
            );
          }
        }

        lines.push("");

        if (tasksWithTiming.length > 1) {
          const avgMin = Math.round(
            totalDuration / tasksWithTiming.length / 60000,
          );
          const longestMin = Math.round(longestDuration / 60000);
          lines.push("### Summary", "");
          lines.push(
            `- **Total tasks:** ${rawTasks.length} | **With timing:** ${tasksWithTiming.length}`,
          );
          lines.push(
            `- **Average:** ${avgMin}m | **Longest:** ${longestTask} (${longestMin}m)`,
          );
          lines.push("");
        }
      }

      return mcpText(lines.join("\n"));
    },
  );
}
