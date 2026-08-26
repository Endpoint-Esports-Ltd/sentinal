/**
 * Spec MCP Tools
 *
 * Registers spec/plan workflow tools on an MCP server. `registerSpecTools` is
 * the single entry point — `src/mcp/server.ts` calls it and nothing else.
 *
 * Tools defined here operate on a plan artifact identified by path:
 *   - spec_register:   Register/update a plan in SQLite
 *   - spec_plan_parse: Parse plan file metadata
 *   - spec_wait_file:  Wait for file to appear on disk
 *
 * The other six live in siblings, because all nine in one file put this module
 * at 681 lines — past the 600-line hard block, which made it uneditable:
 *   - ./status-mcp-tools.ts: spec_config, spec_status, spec_init
 *   - ./events-mcp-tools.ts: spec_notify, spec_events, spec_metrics
 *
 * Those are called from `registerSpecTools` below, following the precedent set
 * by `src/runtime/mcp-tools.ts` → `src/runtime/lifecycle-mcp-tools.ts`: the
 * parent keeps the one exported entry point with an unchanged signature, so
 * `src/mcp/server.ts` needs no change.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { MemoryStore } from "../memory/store.js";
import { parsePlanFile, slugFromFilename } from "./parser.js";
import { SpecStore } from "./store.js";
import { registerSpecStatusTools } from "./status-mcp-tools.js";
import { registerSpecEventsTools } from "./events-mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";

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

  registerSpecRegisterTool(server, client, specStore, effectiveStore);
  registerSpecWaitFileTool(server);
  registerSpecPlanParseTool(server);
  // Siblings: all nine tools inline here breach the 600-line hard block.
  // Delegating keeps `src/mcp/server.ts` unchanged.
  registerSpecStatusTools(server, client, specStore);
  registerSpecEventsTools(server, client, effectiveStore, specStore);
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

        // If status override requested, validate transition and update file
        if (status) {
          // Validate status transition — prevent skipping verification
          const currentSpec = parsePlanFile(plan_path);
          const currentStatus = currentSpec.status;

          const INVALID_TRANSITIONS: Record<string, string[]> = {
            VERIFIED: ["PENDING", "IN_PROGRESS"], // Can't set VERIFIED without going through COMPLETE
          };

          const blockedFrom = INVALID_TRANSITIONS[status];
          if (blockedFrom?.includes(currentStatus)) {
            return mcpText(
              `Cannot transition from ${currentStatus} to ${status}. ` +
                `Plan must go through COMPLETE first (run verification phase). ` +
                `Status transition: PENDING → IN_PROGRESS → COMPLETE → VERIFIED`,
            );
          }

          const content = readFileSync(plan_path, "utf-8");
          const updated = content.replace(/^(Status:\s*).+$/m, `$1${status}`);
          writeFileSync(plan_path, updated);
        }

        // Thread SENTINAL_SESSION_ID when available so the registering session
        // is stamped as the plan's owner. This is how /spec register establishes
        // ownership for the session-aware stop-guard.
        const registeringSession =
          process.env["SENTINAL_SESSION_ID"] ?? undefined;

        if (client) {
          await client.syncSpec(plan_path, projectPath, registeringSession);
          // syncSpec returns void; parse the file for the response
          const parsed = parsePlanFile(plan_path);
          const done = parsed.tasks.filter(
            (t) => t.status === "complete",
          ).length;
          const text = `Registered: ${parsed.id} (${parsed.status}, ${done}/${parsed.tasks.length} tasks)`;
          return mcpText(text);
        }

        const spec = specStore!.syncFromPlanFile(
          plan_path,
          projectPath,
          registeringSession,
        );
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

      return new Promise<ReturnType<typeof mcpText>>((resolve) => {
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
            if (!resolved && filename === targetName && existsSync(file_path)) {
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
      });
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
