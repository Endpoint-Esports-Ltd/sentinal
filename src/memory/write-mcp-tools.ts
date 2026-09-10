/**
 * Memory MCP Tools — write operations
 *
 * `memory_save`, `memory_update`, `memory_delete`, split out of
 * `./mcp-tools.ts` purely for file length (Task 9 of
 * docs/plans/2026-09-02-audit-medium-remediation.md), following the
 * `src/spec/mcp-tools.ts` precedent: the parent keeps the single
 * `registerMemoryTools` entry point, so no import path changes anywhere.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStore } from "./store.js";
import type { MemoryService } from "./service.js";
import { OBSERVATION_TYPES } from "./types.js";
import type { ObservationType } from "./types.js";
import type { SidecarClient } from "../sidecar/client.js";
import { mcpText } from "../mcp/helpers.js";
import { requiredEnum } from "../utils/schema.js";
import { saveToSharedIfRequested } from "./shared.js";

// --- Save ---

export function registerSaveTool(
  server: McpServer,
  service: MemoryService | null,
  store: MemoryStore | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_save",
    "Save an observation to persistent memory. Use for decisions, discoveries, error patterns, fixes, and recurring patterns.",
    {
      title: z.string().min(1).max(500).describe("Short descriptive title"),
      content: z
        .string()
        .min(1)
        .describe("Detailed content of the observation"),
      type: requiredEnum(
        OBSERVATION_TYPES,
        "Type: decision, discovery, error, fix, or pattern",
      ),
      project: z.string().describe("Project path this observation relates to"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags/concepts for categorization"),
      filePaths: z.array(z.string()).optional().describe("Related file paths"),
      shared: z
        .boolean()
        .optional()
        .describe(
          "Also save to shared project memory (.sentinal/project-memory.json)",
        ),
    },
    async ({ title, content, type, project, tags, filePaths, shared }) => {
      // Resolve real session ID when exactly one active session exists
      let sessionId = `mcp-${Date.now()}`;
      try {
        const activeSessions = client
          ? await client.getActiveSessions()
          : store!.getActiveSessions();
        if (activeSessions.length === 1) {
          sessionId = activeSessions[0].id;
        }
      } catch {
        /* fall back to synthetic ID */
      }

      const obsPayload = {
        sessionId,
        projectPath: project,
        type: type as ObservationType,
        title,
        content,
        filePaths: filePaths ?? [],
        tags: tags ?? [],
        metadata: { source: "mcp-tool" },
      };

      let obsId: number;
      if (client) {
        const result = await client.addObservation(obsPayload);
        obsId = result.id;
      } else {
        const result = service!.addObservation({
          ...obsPayload,
          timestamp: Date.now(),
        });
        obsId = result.id;
      }

      // Also save to shared project memory if requested
      const wasShared = await saveToSharedIfRequested({
        project,
        type,
        title,
        content,
        tags,
        filePaths,
        shared,
      });

      const suffix = wasShared
        ? " + shared to project memory"
        : shared
          ? " (shared skipped: only decision/discovery/pattern types can be shared)"
          : "";
      return mcpText(
        `Saved observation #${obsId}: "${title}" (${type})${suffix}`,
      );
    },
  );
}

// --- Update / Delete ---

export function registerUpdateDeleteTools(
  server: McpServer,
  service: MemoryService | null,
  client: SidecarClient | null,
): void {
  server.tool(
    "memory_update",
    "Correct/supersede an existing memory in place (by ID from memory_search/memory_save) instead of saving a new CORRECTION observation. Updates the given fields AND refreshes the memory's staleness (recency + quality) so the corrected fact ranks fresh again. Keeps FTS and vector indexes in sync.",
    {
      id: z.number().describe("Observation ID to update"),
      title: z.string().min(1).max(500).optional().describe("New title"),
      content: z.string().min(1).optional().describe("New content"),
      type: z
        .enum(OBSERVATION_TYPES)
        .optional()
        .describe("New type: decision, discovery, error, fix, or pattern"),
      tags: z.array(z.string()).optional().describe("New tags (replaces)"),
      filePaths: z
        .array(z.string())
        .optional()
        .describe("New file paths (replaces)"),
    },
    async ({ id, title, content, type, tags, filePaths }) => {
      const patch = { id, title, content, type, tags, filePaths };
      const updated = client
        ? await client.updateObservation(patch)
        : service!.updateObservation(id, {
            title,
            content,
            type,
            tags,
            filePaths,
          });
      if (!updated) {
        return mcpText(`Observation #${id} not found — nothing updated.`);
      }
      return mcpText(`Updated observation #${id} (staleness refreshed).`);
    },
  );

  server.tool(
    "memory_delete",
    "Delete a memory by ID. DESTRUCTIVE and unrecoverable — removes the observation from FTS and vector search. Use to remove now-redundant CORRECTION observations after consolidating with memory_update.",
    {
      id: z.number().describe("Observation ID to delete"),
    },
    async ({ id }) => {
      const result = client
        ? await client.deleteObservation(id)
        : { deleted: service!.deleteObservation(id) };
      return mcpText(
        result.deleted
          ? `Deleted observation #${id}.`
          : `Observation #${id} not found — nothing deleted.`,
      );
    },
  );
}
