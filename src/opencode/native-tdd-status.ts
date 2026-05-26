/**
 * Native TDD Status Tool for OpenCode Plugin
 *
 * Returns a raw ToolDefinition (with Zod schemas) for use as a native OpenCode
 * plugin tool. Does NOT use the `tool()` runtime global — safe for use in `src/`.
 */

import { z } from "zod";
import type { SidecarClient } from "../sidecar/client.js";

const argsSchema = {
  file_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to implementation file. If omitted, lists all active TDD states.",
    ),
  spec_id: z
    .string()
    .optional()
    .describe("Filter by spec ID (only used when file_path is omitted)."),
};

export function createTddStatusTool(sidecar: SidecarClient | null): {
  description: string;
  args: typeof argsSchema;
  execute(
    args: Record<string, unknown>,
    context: { directory: string; worktree: string },
  ): Promise<unknown>;
} {
  return {
    description:
      "Get TDD cycle state for a specific file or list all active TDD states. Returns state with structured metadata.",
    args: argsSchema,
    execute: async (args) => {
      if (!sidecar) {
        return {
          content: "Sidecar unavailable — TDD state unknown",
          metadata: { sentinal: { tdd_state: "IDLE" } },
        };
      }

      const filePath = args.file_path as string | undefined;
      const specId = args.spec_id as string | undefined;

      if (filePath) {
        const result = await sidecar.getTddState(filePath);
        return {
          content: `**${filePath}:** ${result.state}${result.hasActiveSpec ? " (active spec)" : ""}`,
          metadata: {
            sentinal: {
              tdd_state: result.state as
                | "IDLE"
                | "TEST_WRITTEN"
                | "RED_CONFIRMED"
                | "GREEN_CONFIRMED",
            },
          },
        };
      } else {
        const states = await sidecar.listActiveTddStates(specId ?? null);
        const content =
          states.length === 0
            ? "No active TDD cycles"
            : states.map((s) => `- **${s.filePath}:** ${s.state}`).join("\n");
        return {
          content,
          metadata: {
            sentinal: {
              tdd_state: states[0]?.state ?? "IDLE",
              active_count: states.length,
            },
          },
        };
      }
    },
  };
}
