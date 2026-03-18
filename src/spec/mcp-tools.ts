/**
 * Spec MCP Tools
 *
 * Registers spec/plan workflow tools on an MCP server.
 * Provides:
 *   - spec_status: Current spec progress and task breakdown
 *   - spec_register: Register/update a plan in SQLite
 *   - spec_wait_file: Wait for file to appear on disk
 *   - spec_config: Read spec workflow toggle env vars
 *   - spec_plan_parse: Parse plan file metadata
 *   - spec_notify: Create notification in SQLite
 *   - spec_events: Get spec event history
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { MemoryStore } from "../memory/store.js";
import { findActivePlan } from "./detect.js";
import { parsePlanFile, slugFromFilename } from "./parser.js";
import { SpecStore } from "./store.js";
import type { SidecarClient } from "../sidecar/client.js";
import type { SpecTask } from "./types.js";

// --- Public API ---

export interface SpecToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}

export function registerSpecTools(
  server: McpServer,
  deps: SpecToolsDeps | MemoryStore | null,
): void {
  // Backwards-compat: bare MemoryStore or null
  let client: SidecarClient | null = null;
  let effectiveStore: MemoryStore | null = null;
  let specStore: SpecStore | null = null;

  if (deps && ("client" in deps || "store" in deps)) {
    const d = deps as SpecToolsDeps;
    client = d.client ?? null;
    effectiveStore = d.store ?? (client ? null : new MemoryStore());
    specStore = effectiveStore ? new SpecStore(effectiveStore) : null;
  } else {
    effectiveStore = (deps as MemoryStore | null) ?? new MemoryStore();
    specStore = new SpecStore(effectiveStore);
  }

  registerSpecStatusTool(server, client, specStore);
  registerSpecRegisterTool(server, client, specStore, effectiveStore);
  registerSpecWaitFileTool(server);
  registerSpecConfigTool(server);
  registerSpecPlanParseTool(server);
  registerSpecNotifyTool(server, client, effectiveStore);
  registerSpecEventsTool(server, client, effectiveStore);
  registerSpecInitTool(server, client, specStore);
}

// --- spec_register ---

function registerSpecRegisterTool(
  server: McpServer,
  client: SidecarClient | null,
  specStore: SpecStore | null,
  effectiveStore: MemoryStore | null,
): void {
  server.tool(
    "spec_register",
    "Register or update a plan in the SQLite index. Optionally override the plan status before syncing.",
    {
      plan_path: z.string().describe("Absolute path to the plan .md file"),
      project: z.string().optional().describe("Project path (defaults to CWD)"),
      status: z
        .string()
        .optional()
        .describe(
          "Override the plan status (e.g. IN_PROGRESS, COMPLETE) — updates the file before syncing",
        ),
    },
    async ({ plan_path, project, status }) => {
      try {
        const projectPath = project ?? process.cwd();

        // If status override requested, update the plan file first (file is source of truth)
        if (status) {
          const content = readFileSync(plan_path, "utf-8");
          const updated = content.replace(/^(Status:\s*).+$/m, `$1${status}`);
          writeFileSync(plan_path, updated);
        }

        if (client) {
          await client.syncSpec(plan_path, projectPath);
          // syncSpec returns void; parse the file for the response
          const parsed = parsePlanFile(plan_path);
          const done = parsed.tasks.filter(
            (t) => t.status === "complete",
          ).length;
          const text = `Registered: ${parsed.id} (${parsed.status}, ${done}/${parsed.tasks.length} tasks)`;
          return mcpText(text);
        }

        const spec = specStore!.syncFromPlanFile(plan_path, projectPath);
        const done = spec.tasks.filter((t) => t.status === "complete").length;
        const text = `Registered: ${spec.id} (${spec.status}, ${done}/${spec.tasks.length} tasks)`;
        return mcpText(text);
      } catch (err) {
        return mcpError("Error registering plan", err);
      }
    },
  );
}

// --- spec_wait_file ---

function registerSpecWaitFileTool(server: McpServer): void {
  server.tool(
    "spec_wait_file",
    "Wait for a file to appear on disk. Returns immediately if the file exists, otherwise watches with a poll fallback. Useful for waiting on reviewer output files.",
    {
      file_path: z.string().describe("Absolute path to the file to wait for"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Timeout in seconds (default 300)"),
    },
    async ({ file_path, timeout_seconds }) => {
      const timeoutMs = (timeout_seconds ?? 300) * 1000;

      // Fast path: file already exists
      if (existsSync(file_path)) {
        return mcpText(`READY: ${file_path}`);
      }

      const targetDir = dirname(file_path);
      const targetName = basename(file_path);

      return new Promise<ReturnType<typeof mcpText>>(
        (resolve) => {
          let watcher: ReturnType<typeof watch> | null = null;
          let pollInterval: ReturnType<typeof setInterval> | null = null;
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          let resolved = false;

          const cleanup = () => {
            if (resolved) return;
            resolved = true;
            if (watcher) {
              try {
                watcher.close();
              } catch {}
            }
            if (pollInterval) clearInterval(pollInterval);
            if (timeoutHandle) clearTimeout(timeoutHandle);
          };

          const onFound = () => {
            cleanup();
            resolve(mcpText(`READY: ${file_path}`));
          };

          const onTimeout = () => {
            cleanup();
            resolve(
              mcpText(
                `TIMEOUT: ${file_path} not found after ${timeout_seconds ?? 300}s`,
              ),
            );
          };

          // fs.watch on parent directory
          try {
            watcher = watch(targetDir, (event, filename) => {
              if (
                !resolved &&
                filename === targetName &&
                existsSync(file_path)
              ) {
                onFound();
              }
            });
            watcher.on("error", () => {
              // Watcher failed — poll fallback handles it
            });
          } catch {
            // Directory doesn't exist or watch not supported — poll handles it
          }

          // Poll fallback every 2 seconds
          pollInterval = setInterval(() => {
            if (!resolved && existsSync(file_path)) {
              onFound();
            }
          }, 2000);

          // Timeout
          timeoutHandle = setTimeout(onTimeout, timeoutMs);
        },
      );
    },
  );
}

// --- spec_config ---

const CONFIG_KEYS = [
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

// --- spec_plan_parse ---

function registerSpecPlanParseTool(server: McpServer): void {
  server.tool(
    "spec_plan_parse",
    "Parse a plan file and return structured metadata including id, title, status, type, tasks, and derived file paths.",
    {
      plan_path: z.string().describe("Absolute path to the plan .md file"),
    },
    async ({ plan_path }) => {
      try {
        const spec = parsePlanFile(plan_path);
        const slug = slugFromFilename(plan_path);
        const basePath = plan_path.replace(/\.md$/i, "");

        const lines = [
          `## Plan: ${spec.title}`,
          "",
          `- **ID:** ${spec.id}`,
          `- **Slug:** ${slug}`,
          `- **Status:** ${spec.status}`,
          `- **Type:** ${spec.type}`,
          `- **Approved:** ${spec.approved ? "Yes" : "No"}`,
          `- **Tasks:** ${spec.tasks.length} total`,
          `- **Plan File:** ${plan_path}`,
          `- **Plan Review Output:** ${basePath}.plan-review.json`,
          `- **Spec Review Output:** ${basePath}.spec-review.json`,
        ];

        if (spec.metadata?.iterations !== undefined) {
          lines.push(`- **Iterations:** ${spec.metadata.iterations}`);
        }
        if (spec.metadata?.worktree !== undefined) {
          lines.push(
            `- **Worktree:** ${spec.metadata.worktree ? "Yes" : "No"}`,
          );
        }

        if (spec.tasks.length > 0) {
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

        return mcpText(lines.join("\n"));
      } catch (err) {
        return mcpError("Error parsing plan", err);
      }
    },
  );
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
      type: z
        .enum(["info", "warning", "error", "success"])
        .describe("Notification type"),
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
      project: z
        .string()
        .describe("Project path to check for active specs"),
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
      const doneTasks = tasks.filter(
        (t) => t.status === "complete",
      ).length;
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
      const remainingTasks = tasks.filter(
        (t) => t.status !== "complete",
      );
      if (remainingTasks.length > 0) {
        lines.push("### Remaining Tasks", "");
        for (const task of remainingTasks) {
          const marker = task.status === "in-progress" ? "[~]" : "[ ]";
          lines.push(
            `- ${marker} Task ${task.position}: ${task.title}`,
          );
        }
        lines.push("");
      }

      return mcpText(lines.join("\n"));
    },
  );
}
