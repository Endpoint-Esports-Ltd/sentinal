/**
 * Compaction Autocontinue Handler
 *
 * Determines whether OpenCode should autocontinue after compaction.
 * Pauses when TDD is in RED state; injects spec resume directive
 * when an active spec is in progress.
 *
 * IMPORTANT: No bun:sqlite imports — safe for use in OpenCode plugin context.
 * The only runtime import is `isInside` from `../worktree/disk-scan.js`
 * (node:fs / node:path / git helpers only), which the plugin bundle already
 * contains via `src/project/identity.ts`.
 */

import type { SidecarClient } from "../sidecar/client.js";
import { isInside } from "../worktree/disk-scan.js";

export interface CompactionAutocontinueResult {
  shouldContinue: boolean;
  context: string[];
}

/**
 * The two roots this handler needs. They differ in any linked worktree and
 * MUST NOT be conflated (see `src/project/identity.ts`):
 * - `identity`  — canonical main-checkout path; a STORAGE KEY only.
 * - `workspace` — the local checkout root; an ON-DISK prefix only.
 */
export interface CompactionRoots {
  identity: string;
  workspace: string;
}

/**
 * Evaluate whether autocontinue should proceed after compaction.
 *
 * Logic:
 * 1. If sidecar is null → allow continue (no data available)
 * 2. If any TDD state under the workspace is RED_CONFIRMED → pause
 * 3. If an active spec (keyed by identity) is IN_PROGRESS → inject resume directive
 * 4. Otherwise → allow continue with no extra context
 */
export async function handleCompactionAutocontinue(
  sidecar: SidecarClient | null,
  roots: CompactionRoots,
): Promise<CompactionAutocontinueResult> {
  if (sidecar === null) {
    return { shouldContinue: true, context: [] };
  }

  // Check TDD state — pause if any file in THIS checkout is in RED_CONFIRMED.
  // `filePath` is an on-disk path, so it is matched against the WORKSPACE.
  // `isInside` is strict and separator-aware (a `<root>-evil` sibling does not
  // match). A relative `filePath` resolves against the process cwd and is
  // excluded — fail-open, matching prior behaviour.
  const allTddStates = await sidecar.listActiveTddStates();
  const tddStates = allTddStates.filter((cycle) =>
    isInside(cycle.filePath, roots.workspace),
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

  // Check for active spec — specs are stored under the canonical IDENTITY key.
  const spec = await sidecar.getCurrentSpec(roots.identity);
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
