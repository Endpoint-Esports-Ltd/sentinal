/**
 * TDD MCP Tools
 *
 * Registers TDD guard management tools on an MCP server.
 * Provides:
 *   - tdd_status: Get current TDD cycle state for a file or list all active
 *     states in the current project (optional `project`, default cwd)
 *   - tdd_set_state: Set TDD cycle state for a file (e.g., bypass guard with RED_CONFIRMED)
 *   - tdd_clear: Clear TDD state for a file or all files in a spec
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpText, mcpError } from "../mcp/helpers.js";
import { MemoryStore } from "../memory/store.js";
import { TDD_CYCLE_STATES } from "../memory/types.js";
import { scopeCyclesToProject } from "../opencode/native-tdd-status.js";
import { resolveProjectIdentity } from "../project/identity.js";
import type { SidecarClient } from "../sidecar/client.js";
import { requiredEnum } from "../utils/schema.js";

// --- Public API ---

export interface TddToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}

export function registerTddTools(server: McpServer, deps: TddToolsDeps): void {
  const { client = null, store = null } = deps;
  const effectiveStore = store ?? (client ? null : new MemoryStore());

  registerTddStatusTool(server, client, effectiveStore);
  registerTddSetStateTool(server, client, effectiveStore);
  registerTddClearTool(server, client, effectiveStore);
}

// --- tdd_status ---

function registerTddStatusTool(
  server: McpServer,
  client: SidecarClient | null,
  store: MemoryStore | null,
): void {
  server.tool(
    "tdd_status",
    "Get TDD guard state for a specific file, or list all active TDD cycle states in the current project (other projects' cycles are excluded). Use to check if a file is blocked by the TDD guard.",
    {
      file_path: z
        .string()
        .optional()
        .describe(
          "File path to check (returns single state). Omit to list all active states in the current project.",
        ),
      spec_id: z
        .string()
        .optional()
        .describe(
          "Filter active states by spec ID (only used when file_path is omitted). Combined with the project scope, not a replacement for it.",
        ),
      project: z
        .string()
        .optional()
        .describe(
          "Project path that scopes the list (only used when file_path is omitted). Defaults to the current working directory; a worktree or subdirectory resolves to its main checkout.",
        ),
    },
    async ({ file_path, spec_id, project }) => {
      try {
        // Single file lookup
        if (file_path) {
          if (client) {
            const result = await client.getTddState(file_path);
            return mcpText(
              `**${file_path}:** ${result.state} (active spec: ${result.hasActiveSpec})`,
            );
          }
          const tdd = store!.getTddState(file_path);
          const state = tdd?.state ?? "IDLE";
          return mcpText(`**${file_path}:** ${state}`);
        }

        // List active states in this project. Scoped on BOTH paths: the store
        // filters in SQL; the sidecar route cannot take a project yet, so the
        // client path filters the fetched rows (see scopeCyclesToProject).
        const identity = resolveProjectIdentity(project ?? process.cwd());
        const states = client
          ? scopeCyclesToProject(
              await client.listActiveTddStates(spec_id ?? null),
              identity,
            )
          : store!.listActiveTddStates(spec_id ?? null, identity);

        if (states.length === 0) {
          return mcpText("No active TDD states.");
        }

        const lines = [`## ${states.length} active TDD state(s)`, ""];
        for (const s of states) {
          lines.push(
            `- **${s.filePath}:** ${s.state} (updated: ${new Date(s.updatedAt).toISOString()})`,
          );
        }

        return mcpText(lines.join("\n"));
      } catch (err) {
        return mcpError("Error getting TDD status", err);
      }
    },
  );
}

// --- tdd_set_state ---

function registerTddSetStateTool(
  server: McpServer,
  client: SidecarClient | null,
  store: MemoryStore | null,
): void {
  server.tool(
    "tdd_set_state",
    "Set TDD cycle state for a file. Use state 'RED_CONFIRMED' to bypass the TDD guard and allow editing an implementation file.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the implementation file"),
      state: requiredEnum(
        TDD_CYCLE_STATES,
        "TDD cycle state: IDLE, TEST_WRITTEN, RED_CONFIRMED, GREEN_CONFIRMED",
      ),
      spec_id: z.string().optional().describe("Associated spec ID"),
      test_file_path: z
        .string()
        .optional()
        .describe("Path to the corresponding test file"),
      project: z
        .string()
        .optional()
        .describe(
          "Project the file belongs to. Defaults to the current working directory; a worktree or subdirectory resolves to its main checkout.",
        ),
    },
    async ({ file_path, state, spec_id, test_file_path, project }) => {
      try {
        // Always recorded, on BOTH paths: a NULL-project RED row is never
        // cleared by the project-scoped confirm_green, so it would leave the
        // file in the guard's bypass state indefinitely.
        const opts = {
          filePath: file_path,
          state,
          specId: spec_id,
          testFilePath: test_file_path,
          projectPath: resolveProjectIdentity(project ?? process.cwd()),
        };

        if (client) {
          await client.setTddState(opts);
        } else {
          store!.setTddState(opts);
        }

        return mcpText(`Set TDD state: ${file_path} → ${state}`);
      } catch (err) {
        return mcpError("Error setting TDD state", err);
      }
    },
  );
}

// --- tdd_clear ---

function registerTddClearTool(
  server: McpServer,
  client: SidecarClient | null,
  store: MemoryStore | null,
): void {
  server.tool(
    "tdd_clear",
    "Clear TDD cycle state for a specific file or all files associated with a spec. Provide file_path OR spec_id (at least one required).",
    {
      file_path: z
        .string()
        .optional()
        .describe("Clear state for this specific file"),
      spec_id: z
        .string()
        .optional()
        .describe("Clear all TDD states for this spec ID"),
    },
    async ({ file_path, spec_id }) => {
      try {
        if (!file_path && !spec_id) {
          return mcpText(
            "Error: Provide file_path or spec_id (at least one required).",
          );
        }

        if (file_path) {
          if (client) {
            await client.clearTddState(file_path);
          } else {
            store!.clearTddState(file_path);
          }
          return mcpText(`Cleared TDD state for: ${file_path}`);
        }

        if (spec_id) {
          if (client) {
            await client.clearTddStatesForSpec(spec_id);
          } else {
            store!.clearTddStatesForSpec(spec_id);
          }
          return mcpText(`Cleared all TDD states for spec: ${spec_id}`);
        }

        return mcpText("No action taken.");
      } catch (err) {
        return mcpError("Error clearing TDD state", err);
      }
    },
  );
}
