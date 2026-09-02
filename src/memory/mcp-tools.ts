/**
 * Memory MCP Tools
 *
 * Registers persistent memory tools on an MCP server.
 * Implements 3-layer progressive disclosure:
 *   1. memory_search  -> compact index with IDs (~50-100 tokens/result)
 *   2. memory_timeline -> context window around an anchor
 *   3. memory_get     -> full details for filtered IDs
 *   4. memory_save    -> manually persist an observation
 *   5. memory_stats   -> database statistics
 *
 * `registerMemoryTools` is the single entry point — `src/mcp/server.ts` calls
 * it and nothing else. This file keeps the read layers (search / timeline /
 * get); the rest live in siblings, split purely for file length (Task 9 of
 * docs/plans/2026-09-02-audit-medium-remediation.md), following the
 * `src/spec/mcp-tools.ts` precedent:
 *   - ./write-mcp-tools.ts:    memory_save, memory_update, memory_delete
 *   - ./maintain-mcp-tools.ts: memory_maintain
 *   - ./stats-mcp-tools.ts:    memory_stats (+ formatMemoryStats, re-exported
 *                              here so existing imports keep working)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  withAbort,
  emitProgress,
  type ProgressExtra,
} from "../mcp/tool-runtime.js";
import type { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { OBSERVATION_TYPES } from "./types.js";
import type { ObservationType } from "./types.js";
import type { SidecarClient } from "../sidecar/client.js";
import { mcpText } from "../mcp/helpers.js";
import { registerSharedTools } from "./shared.js";
import {
  registerSaveTool,
  registerUpdateDeleteTools,
} from "./write-mcp-tools.js";
import { registerMaintainTool } from "./maintain-mcp-tools.js";
import { registerStatsTool } from "./stats-mcp-tools.js";

export { formatMemoryStats } from "./stats-mcp-tools.js";

export interface MemoryToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}

// --- Public API ---

export function registerMemoryTools(
  server: McpServer,
  deps: MemoryToolsDeps | MemoryStore,
): MemoryService | null {
  // Backwards compat: if passed a MemoryStore directly, wrap it
  if ("insertSession" in deps) {
    const store = deps as MemoryStore;
    const service = new MemoryService(store);
    registerSearchTool(server, service, null);
    registerTimelineTool(server, service, null);
    registerGetTool(server, service, null);
    registerSaveTool(server, service, store, null);
    registerUpdateDeleteTools(server, service, null);
    registerStatsTool(server, service, null);
    registerMaintainTool(server, store);
    registerSharedTools(server, { service, client: null });
    return service;
  }

  const { client = null, store = null } = deps;
  const service = store ? new MemoryService(store) : null;

  registerSearchTool(server, service, client);
  registerTimelineTool(server, service, client);
  registerGetTool(server, service, client);
  registerSaveTool(server, service, store, client);
  registerUpdateDeleteTools(server, service, client);
  registerStatsTool(server, service, client);
  // Unconditional (M6b): in sidecar mode (store null) the maintain handler
  // opens a scoped direct MemoryStore per call — see ./maintain-mcp-tools.ts
  // for why there is deliberately no sidecar route.
  registerMaintainTool(server, store);
  registerSharedTools(server, { client, service });
  return service;
}

// --- Layer 1: Search (compact index) ---

function registerSearchTool(
  server: McpServer,
  service: MemoryService | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_search",
    "Search memory observations. Returns a compact index with IDs and titles. Use memory_get for full details of specific results.",
    {
      query: z.string().describe("Search query (semantic + keyword)"),
      project: z.string().optional().describe("Filter by project path"),
      type: z
        .enum(OBSERVATION_TYPES)
        .optional()
        .describe("Filter by observation type"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results (default 20)"),
    },
    async ({ query, project, type, limit }, extra) => {
      const progressExtra = extra as ProgressExtra | undefined;
      // Embedding cold-start can be slow; emit an initial progress ping and
      // honor client cancellation via extra.signal.
      await emitProgress(progressExtra, { progress: 0, message: "searching" });
      const searchPromise = client
        ? client.memorySearch({
            query,
            project,
            type,
            limit: limit ?? 20,
          })
        : service!.search(query, {
            project,
            type: type as ObservationType | undefined,
            limit: limit ?? 20,
          });
      const results = await withAbort(
        (extra as { signal?: AbortSignal } | undefined)?.signal,
        searchPromise,
      );
      await emitProgress(progressExtra, { progress: 1, message: "done" });

      if (results.length === 0) {
        return mcpText("No matching observations found.");
      }

      const header = "| ID | Date | Type | Title | ~Tokens |";
      const separator = "|---:|------|------|-------|--------:|";
      const rows = results.map((r) => {
        const date = new Date(r.timestamp).toISOString().split("T")[0];
        return `| ${r.id} | ${date} | ${r.type} | ${r.title} | ${r.estimatedTokens} |`;
      });

      const text = [
        `Found ${results.length} observation(s):`,
        "",
        header,
        separator,
        ...rows,
        "",
        "Use `memory_get` with specific IDs to retrieve full details.",
      ].join("\n");

      return mcpText(text);
    },
  );
}

// --- Layer 2: Timeline (context around anchor) ---

function registerTimelineTool(
  server: McpServer,
  service: MemoryService | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_timeline",
    "Get chronological context around an observation. Shows observations before and after the anchor point.",
    {
      anchor: z.number().describe("Observation ID to center the timeline on"),
      depth: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("How many observations before/after (default 5)"),
      project: z.string().optional().describe("Filter by project path"),
    },
    async ({ anchor, depth, project }) => {
      const d = depth ?? 5;
      const result = client
        ? await client.memoryTimeline({ anchor, depth: d, project })
        : service!.timeline(anchor, d, d, project);

      if (result.entries.length === 0) {
        return mcpText(`Observation #${anchor} not found.`);
      }

      const lines: string[] = [`Timeline around observation #${anchor}:`, ""];
      for (const entry of result.entries) {
        const date = new Date(entry.timestamp).toISOString().split("T")[0];
        const marker = entry.isAnchor ? ">>>" : "   ";
        lines.push(
          `${marker} [${entry.id}] ${date} (${entry.type}) ${entry.title}`,
        );
        if (entry.snippet) {
          lines.push(`       ${entry.snippet.slice(0, 120)}`);
        }
      }

      lines.push(
        "",
        `${result.totalBefore} before, ${result.totalAfter} after.`,
      );
      lines.push(
        "Use `memory_get` with specific IDs to retrieve full details.",
      );

      return mcpText(lines.join("\n"));
    },
  );
}

// --- Layer 3: Get (full details) ---

function registerGetTool(
  server: McpServer,
  service: MemoryService | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_get",
    "Fetch full observation details by IDs. Only call after filtering with memory_search or memory_timeline.",
    {
      ids: z
        .array(z.number())
        .min(1)
        .max(20)
        .describe("Observation IDs to retrieve"),
    },
    async ({ ids }) => {
      const observations = client
        ? await client.memoryGet(ids)
        : service!.getObservations(ids);

      if (observations.length === 0) {
        return mcpText("No observations found for the given IDs.");
      }

      const blocks = observations.map((obs) => {
        const date = new Date(obs.timestamp).toISOString().split("T")[0];
        const lines = [
          `## Observation #${obs.id}`,
          "",
          `- **Type:** ${obs.type}`,
          `- **Date:** ${date}`,
          `- **Project:** ${obs.projectPath}`,
        ];

        if (obs.tags.length > 0) {
          lines.push(`- **Tags:** ${obs.tags.join(", ")}`);
        }
        if (obs.filePaths.length > 0) {
          lines.push(`- **Files:** ${obs.filePaths.join(", ")}`);
        }

        lines.push("", `### ${obs.title}`, "", obs.content);

        return lines.join("\n");
      });

      return mcpText(blocks.join("\n\n---\n\n"));
    },
  );
}
