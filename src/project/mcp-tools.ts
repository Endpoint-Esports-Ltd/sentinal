/**
 * Project MCP Tools
 *
 * Registers project context tools on an MCP server.
 * Provides:
 *   - project_context: structured project summary in one call
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SidecarClient } from "../sidecar/client.js";
import { analyzeProject, formatProjectContext, type ProjectContext } from "./context.js";

// --- Public API ---

export interface ProjectToolsDeps {
  client?: SidecarClient | null;
}

export function registerProjectTools(
  server: McpServer,
  deps: ProjectToolsDeps,
): void {
  const { client = null } = deps;

  server.tool(
    "project_context",
    "Get a structured project summary including tech stack, directory layout, key commands, and conventions. Call once per session for project understanding.",
    {
      project: z.string().describe("Project root path"),
      refresh: z.boolean().optional().describe("Force re-analysis (ignores cache)"),
    },
    async ({ project, refresh }) => {
      let ctx: ProjectContext;

      if (client) {
        try {
          const data = await client.projectContext(project, refresh);
          ctx = data as unknown as ProjectContext;
        } catch {
          // Sidecar unavailable — fall back to direct analysis
          ctx = analyzeProject(project);
        }
      } else {
        ctx = analyzeProject(project);
      }

      const text = formatProjectContext(ctx);
      return { content: [{ type: "text", text }] };
    },
  );
}
