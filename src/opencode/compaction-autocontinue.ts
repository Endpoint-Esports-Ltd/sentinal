/**
 * Compaction Autocontinue Handler
 *
 * Determines whether OpenCode should autocontinue after compaction.
 * Pauses when TDD is in RED state; injects spec resume directive
 * when an active spec is in progress.
 *
 * IMPORTANT: No bun:sqlite imports — safe for use in OpenCode plugin context.
 */

import type { SidecarClient } from "../sidecar/client.js";

export interface CompactionAutocontinueResult {
  shouldContinue: boolean;
  context: string[];
}

/**
 * Evaluate whether autocontinue should proceed after compaction.
 *
 * Logic:
 * 1. If sidecar is null → allow continue (no data available)
 * 2. If any TDD state is RED_CONFIRMED → pause (failing tests must be fixed first)
 * 3. If an active spec is IN_PROGRESS → inject resume directive
 * 4. Otherwise → allow continue with no extra context
 */
export async function handleCompactionAutocontinue(
  sidecar: SidecarClient | null,
  projectPath: string,
): Promise<CompactionAutocontinueResult> {
  if (sidecar === null) {
    return { shouldContinue: true, context: [] };
  }

  // Check TDD state — pause if any file in THIS project is in RED_CONFIRMED
  // Filter by projectPath to avoid false positives from other projects open simultaneously
  const allTddStates = await sidecar.listActiveTddStates();
  const tddStates = allTddStates.filter((cycle) =>
    cycle.filePath.startsWith(projectPath),
  );
  const hasRedState = tddStates.some(
    (cycle) => cycle.state === "RED_CONFIRMED",
  );
  if (hasRedState) {
    return {
      shouldContinue: false,
      context: [
        "TDD cycle is in RED state — fix failing tests before continuing",
      ],
    };
  }

  // Check for active spec and inject resume directive
  const spec = await sidecar.getCurrentSpec(projectPath);
  if (spec !== null && spec.status === "IN_PROGRESS") {
    // Find current task: first in-progress, then first pending
    const currentTask =
      spec.tasks.find((t) => t.status === "in-progress") ??
      spec.tasks.find((t) => t.status === "pending");

    if (currentTask) {
      const directive = `Resume spec: ${spec.planFile} — current task: Task ${currentTask.position}: ${currentTask.title}`;
      return { shouldContinue: true, context: [directive] };
    }
  }

  // Idle — no TDD red, no active spec
  return { shouldContinue: true, context: [] };
}
