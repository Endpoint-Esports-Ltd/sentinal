/**
 * Native TDD Status Tool for OpenCode Plugin
 *
 * Returns a raw ToolDefinition (with Zod schemas) for use as a native OpenCode
 * plugin tool. Does NOT use the `tool()` runtime global — safe for use in `src/`.
 */

import { z } from "zod";
import type { TddCycle } from "../memory/types.js";
import { resolveProjectIdentity } from "../project/identity.js";
import type { SidecarClient } from "../sidecar/client.js";

/**
 * Keep only the cycles that belong to `projectIdentity` (already resolved via
 * `resolveProjectIdentity` — rows are keyed by the storage identity).
 *
 * Used on the SIDECAR path, whose `/tdd-state/list` route cannot yet take a
 * project, so the fetched rows are filtered here. Semantics mirror
 * `MemoryStore.listActiveTddStates(specId, projectPath)`, with one read-side
 * concession (D6 — reads fail OPEN):
 *
 * - `projectPath === identity` → kept.
 * - `projectPath` is `null` or another project → dropped (the store's
 *   `project_path = ?` clause excludes NULL rows too).
 * - `projectPath` key ABSENT → kept. Only a pre-V13 sidecar omits the field,
 *   and it cannot tell us the project; hiding every row would be a silent
 *   empty answer, which is worse than an over-broad one.
 */
export function scopeCyclesToProject<T extends Pick<TddCycle, "projectPath">>(
  cycles: T[],
  projectIdentity: string,
): T[] {
  return cycles.filter(
    (c) => c.projectPath === undefined || c.projectPath === projectIdentity,
  );
}

const argsSchema = {
  file_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to implementation file. If omitted, lists all active TDD states in the current project (other projects' cycles are excluded).",
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
      "Get TDD cycle state for a specific file, or list all active TDD states in the current project. Returns state with structured metadata.",
    args: argsSchema,
    execute: async (args, context) => {
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
                "IDLE" | "TEST_WRITTEN" | "RED_CONFIRMED" | "GREEN_CONFIRMED",
            },
          },
        };
      } else {
        const identity = resolveProjectIdentity(
          context?.directory || process.cwd(),
        );
        // The project also resolves a shared spec slug to THIS project's
        // key (D6); rows are still filtered for pre-Task-10 sidecars.
        const states = scopeCyclesToProject(
          await sidecar.listActiveTddStates(specId ?? null, identity),
          identity,
        );
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
