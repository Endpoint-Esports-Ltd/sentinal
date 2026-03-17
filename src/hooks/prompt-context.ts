/**
 * Prompt Context Hook — `sentinal hook shared prompt-context`
 *
 * UserPromptSubmit hook that injects active spec state into every prompt.
 * Ensures the AI always knows the current workflow state (plan path,
 * current task, progress %) without relying on conversation memory.
 *
 * Fast-path: exits immediately (~2ms) when no active plan exists.
 *
 * NOTE: The context formatting logic is duplicated in the OpenCode plugin
 * (`targets/opencode/plugins/sentinal.ts` compaction handler) since the
 * plugin can't import from src/. Keep both in sync when changing format.
 */

import { readStdin, hint, output } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan } from "../spec/detect.js";
import type { Spec, SpecTask } from "../spec/types.js";

/**
 * Build a markdown context block with active spec state.
 * Returns null if no active plan is found.
 *
 * Exported for testing and reuse by other hooks.
 */
export function buildSpecContext(searchDir: string): string | null {
  const active = findActivePlan(searchDir);
  if (!active) return null;

  const { filePath, spec } = active;
  const tasks = spec.tasks ?? [];
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "complete").length;
  const remaining = total - completed;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Find current task: first in-progress, or first pending
  const currentTask =
    tasks.find((t) => t.status === "in-progress") ??
    tasks.find((t) => t.status === "pending") ??
    null;

  const lines: string[] = [
    "## Active Spec State",
    "",
    `**Active Plan:** ${filePath}`,
    `**Status:** ${spec.status}`,
    `**Progress:** ${percent}% (${completed}/${total} tasks, ${remaining} remaining)`,
  ];

  if (currentTask) {
    lines.push(
      `**Current Task:** Task ${currentTask.position}: ${currentTask.title}`,
    );
  }

  lines.push(
    "",
    `Resume with \`/spec ${filePath}\` if needed.`,
  );

  return lines.join("\n");
}

export async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const gitRoot = await findGitRoot(input.cwd);
    const searchDir = gitRoot ?? input.cwd;

    const context = buildSpecContext(searchDir);
    if (context) {
      output(hint("UserPromptSubmit", context));
    }
  } catch {
    // Non-fatal — context injection is supplementary
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
