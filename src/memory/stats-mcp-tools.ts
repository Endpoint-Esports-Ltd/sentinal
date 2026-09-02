/**
 * Memory MCP Tools — stats
 *
 * `memory_stats` plus the markdown renderers, split out of `./mcp-tools.ts`
 * purely for file length (Task 9 of
 * docs/plans/2026-09-02-audit-medium-remediation.md), following the
 * `src/spec/mcp-tools.ts` precedent: the parent keeps the single
 * `registerMemoryTools` entry point (and re-exports `formatMemoryStats`), so
 * no import path changes anywhere.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryService } from "./service.js";
import type { MemoryStats, VectorSearchStats } from "./types.js";
import type { SidecarClient } from "../sidecar/client.js";
import { mcpText } from "../mcp/helpers.js";

// --- Stats ---

export function registerStatsTool(
  server: McpServer,
  service: MemoryService | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_stats",
    "Get memory database statistics: total observations, sessions, breakdown by type and project.",
    {},
    async () => {
      const stats = client ? await client.memoryStats() : service!.getStats();
      return mcpText(formatMemoryStats(stats));
    },
  );
}

/**
 * Render MemoryStats as markdown. Exported for testing. The vector section
 * is omitted when the payload has no `vector` field (e.g. an old sidecar).
 */
export function formatMemoryStats(stats: MemoryStats): string {
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

  const typeEntries = Object.entries(stats.byType).filter(
    ([, v]) => (v as number) > 0,
  );
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

  if (stats.vector) {
    lines.push("", "### Vector Search", ...formatVectorSection(stats.vector));
  }

  return lines.join("\n");
}

function formatVectorSection(vector: VectorSearchStats): string[] {
  switch (vector.status) {
    case "ready":
      return [`- **Status:** available (${vector.count} vectors)`];
    case "initializing":
      return ["- **Status:** initializing"];
    case "disabled":
      return ["- **Status:** disabled"];
    case "unavailable": {
      const lines = ["- **Status:** unavailable"];
      if (vector.initError) lines.push(`- **Error:** ${vector.initError}`);
      if (vector.hint) lines.push(`- **Hint:** ${vector.hint}`);
      return lines;
    }
  }
}
