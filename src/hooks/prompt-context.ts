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
import type { HintOutput } from "../utils/hook-output.js";
import { findGitRoot } from "../utils/git.js";
import { findActivePlan } from "../spec/detect.js";
import type { Spec, SpecTask } from "../spec/types.js";

/** Extended hook output that may include sessionTitle and/or additionalContext. */
interface HintWithSessionTitle {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext?: string;
    sessionTitle?: string;
  };
}

/** Statuses that count as "active" for session title purposes. */
const SESSION_TITLE_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);

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

  // Add action prompt based on status
  if (spec.status === "COMPLETE") {
    lines.push(
      "",
      `**Action Required:** Plan is COMPLETE but not VERIFIED. Run \`/spec ${filePath}\` to start verification.`,
    );
  } else {
    lines.push(
      "",
      `Resume with \`/spec ${filePath}\` if needed.`,
    );
  }

  return lines.join("\n");
}

/**
 * Build a sessionTitle string for the active spec, if one exists.
 * Returns `"spec:<slug>"` when a PENDING or IN_PROGRESS spec is active,
 * or `null` if no qualifying spec is found.
 *
 * Truncated to 80 chars: prefix "spec:" (5 chars) + up to 75 slug chars.
 *
 * Exported for testing.
 */
export function buildSessionTitle(searchDir: string): string | null {
  const active = findActivePlan(searchDir);
  if (!active) return null;
  if (!SESSION_TITLE_STATUSES.has(active.spec.status)) return null;

  const slug = active.spec.id.slice(0, 75);
  return `spec:${slug}`;
}

export async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const gitRoot = await findGitRoot(input.cwd);
    const searchDir = gitRoot ?? input.cwd;

    const context = buildSpecContext(searchDir);
    const sessionTitle = buildSessionTitle(searchDir);

    if (context && sessionTitle) {
      const out: HintWithSessionTitle = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
          sessionTitle,
        },
      };
      output(out as HintOutput);
    } else if (context) {
      output(hint("UserPromptSubmit", context));
    } else if (sessionTitle) {
      // Active spec found (sessionTitle set) but no context available — still set title
      const out: HintWithSessionTitle = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          sessionTitle,
        },
      };
      output(out as HintOutput);
    }
  } catch {
    // Non-fatal — context injection is supplementary
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
