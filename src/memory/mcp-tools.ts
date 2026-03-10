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
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { OBSERVATION_TYPES } from "./types.js";
import type { ObservationType } from "./types.js";
import type { SidecarClient } from "../sidecar/client.js";

export interface MemoryToolsDeps {
  client?: SidecarClient | null;
  store?: MemoryStore | null;
}

// --- Public API ---

export function registerMemoryTools(server: McpServer, deps: MemoryToolsDeps | MemoryStore): MemoryService | null {
  // Backwards compat: if passed a MemoryStore directly, wrap it
  if ("insertSession" in deps) {
    const store = deps as MemoryStore;
    const service = new MemoryService(store);
    registerSearchTool(server, service, null);
    registerTimelineTool(server, service, null);
    registerGetTool(server, service, null);
    registerSaveTool(server, service, store, null);
    registerStatsTool(server, service, null);
    return service;
  }

  const { client = null, store = null } = deps;
  const service = store ? new MemoryService(store) : null;

  registerSearchTool(server, service, client);
  registerTimelineTool(server, service, client);
  registerGetTool(server, service, client);
  registerSaveTool(server, service, store, client);
  registerStatsTool(server, service, client);
  return service;
}

// --- Layer 1: Search (compact index) ---

function registerSearchTool(server: McpServer, service: MemoryService | null, client: SidecarClient | null): void {
  server.tool(
    "memory_search",
    "Search memory observations. Returns a compact index with IDs and titles. Use memory_get for full details of specific results.",
    {
      query: z.string().describe("Search query (semantic + keyword)"),
      project: z.string().optional().describe("Filter by project path"),
      type: z.enum(OBSERVATION_TYPES).optional().describe("Filter by observation type"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async ({ query, project, type, limit }) => {
      const results = client
        ? await client.memorySearch({ query, project, type, limit: limit ?? 20 })
        : await service!.search(query, { project, type: type as ObservationType | undefined, limit: limit ?? 20 });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching observations found." }] };
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

      return { content: [{ type: "text", text }] };
    },
  );
}

// --- Layer 2: Timeline (context around anchor) ---

function registerTimelineTool(server: McpServer, service: MemoryService | null, client: SidecarClient | null): void {
  server.tool(
    "memory_timeline",
    "Get chronological context around an observation. Shows observations before and after the anchor point.",
    {
      anchor: z.number().describe("Observation ID to center the timeline on"),
      depth: z.number().min(1).max(50).optional().describe("How many observations before/after (default 5)"),
      project: z.string().optional().describe("Filter by project path"),
    },
    async ({ anchor, depth, project }) => {
      const d = depth ?? 5;
      const result = client
        ? await client.memoryTimeline({ anchor, depth: d, project })
        : service!.timeline(anchor, d, d, project);

      if (result.entries.length === 0) {
        return { content: [{ type: "text", text: `Observation #${anchor} not found.` }] };
      }

      const lines: string[] = [`Timeline around observation #${anchor}:`, ""];
      for (const entry of result.entries) {
        const date = new Date(entry.timestamp).toISOString().split("T")[0];
        const marker = entry.isAnchor ? ">>>" : "   ";
        lines.push(`${marker} [${entry.id}] ${date} (${entry.type}) ${entry.title}`);
        if (entry.snippet) {
          lines.push(`       ${entry.snippet.slice(0, 120)}`);
        }
      }

      lines.push("", `${result.totalBefore} before, ${result.totalAfter} after.`);
      lines.push("Use `memory_get` with specific IDs to retrieve full details.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// --- Layer 3: Get (full details) ---

function registerGetTool(server: McpServer, service: MemoryService | null, client: SidecarClient | null): void {
  server.tool(
    "memory_get",
    "Fetch full observation details by IDs. Only call after filtering with memory_search or memory_timeline.",
    {
      ids: z.array(z.number()).min(1).max(20).describe("Observation IDs to retrieve"),
    },
    async ({ ids }) => {
      const observations = client
        ? await client.memoryGet(ids)
        : service!.getObservations(ids);

      if (observations.length === 0) {
        return { content: [{ type: "text", text: "No observations found for the given IDs." }] };
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

      return { content: [{ type: "text", text: blocks.join("\n\n---\n\n") }] };
    },
  );
}

// --- Save ---

function registerSaveTool(
  server: McpServer, service: MemoryService | null,
  store: MemoryStore | null, client: SidecarClient | null,
): void {
  server.tool(
    "memory_save",
    "Save an observation to persistent memory. Use for decisions, discoveries, error patterns, fixes, and recurring patterns.",
    {
      title: z.string().min(1).max(500).describe("Short descriptive title"),
      content: z.string().min(1).describe("Detailed content of the observation"),
      type: z.enum(OBSERVATION_TYPES).describe("Type: decision, discovery, error, fix, or pattern"),
      project: z.string().describe("Project path this observation relates to"),
      tags: z.array(z.string()).optional().describe("Tags/concepts for categorization"),
      filePaths: z.array(z.string()).optional().describe("Related file paths"),
    },
    async ({ title, content, type, project, tags, filePaths }) => {
      // Resolve real session ID when exactly one active session exists
      let sessionId = `mcp-${Date.now()}`;
      try {
        const activeSessions = client
          ? await client.getActiveSessions()
          : store!.getActiveSessions();
        if (activeSessions.length === 1) {
          sessionId = activeSessions[0].id;
        }
      } catch { /* fall back to synthetic ID */ }

      const obsPayload = {
        sessionId, projectPath: project, type: type as ObservationType,
        title, content, filePaths: filePaths ?? [], tags: tags ?? [],
        metadata: { source: "mcp-tool" },
      };

      let obsId: number;
      if (client) {
        const result = await client.addObservation(obsPayload);
        obsId = result.id;
      } else {
        const result = service!.addObservation({ ...obsPayload, timestamp: Date.now() });
        obsId = result.id;
      }

      return {
        content: [{
          type: "text",
          text: `Saved observation #${obsId}: "${title}" (${type})`,
        }],
      };
    },
  );
}

// --- Stats ---

function registerStatsTool(server: McpServer, service: MemoryService | null, client: SidecarClient | null): void {
  server.tool(
    "memory_stats",
    "Get memory database statistics: total observations, sessions, breakdown by type and project.",
    {},
    async () => {
      const stats = client ? await client.memoryStats() : service!.getStats();

      const lines = [
        "## Memory Statistics",
        "",
        `- **Total Observations:** ${stats.totalObservations}`,
        `- **Total Sessions:** ${stats.totalSessions}`,
        `- **Database Size:** ${(stats.databaseSizeBytes / 1024).toFixed(1)} KB`,
      ];

      if (stats.oldestTimestamp && stats.newestTimestamp) {
        const oldest = new Date(stats.oldestTimestamp).toISOString().split("T")[0];
        const newest = new Date(stats.newestTimestamp).toISOString().split("T")[0];
        lines.push(`- **Date Range:** ${oldest} to ${newest}`);
      }

      const typeEntries = Object.entries(stats.byType).filter(([, v]) => (v as number) > 0);
      if (typeEntries.length > 0) {
        lines.push("", "### By Type");
        for (const [t, count] of typeEntries) {
          lines.push(`- ${t}: ${count}`);
        }
      }

      const projectEntries = Object.entries(stats.byProject);
      if (projectEntries.length > 0) {
        lines.push("", "### By Project");
        for (const [p, count] of projectEntries) {
          lines.push(`- ${p}: ${count}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
