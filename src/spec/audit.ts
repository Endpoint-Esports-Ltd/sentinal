/**
 * Spec completion audit — cross-checks a plan file's checkboxes against the
 * SQLite task states. Split out of `store.ts` for length; `SpecStore`
 * delegates to it (`auditCompletion`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parsePlanFile } from "./parser.js";
import type { SpecStore } from "./store.js";

export interface AuditFix {
  taskPosition: number;
  taskTitle: string;
  issue: "md-ahead" | "sqlite-ahead";
  /** What was changed: "updated-sqlite" or "updated-md" */
  action: string;
}

export interface AuditResult {
  specId: string;
  totalTasks: number;
  completeTasks: number;
  fixes: AuditFix[];
  inSync: boolean;
}

/**
 * Cross-check plan file checkboxes against SQLite task states.
 * Fixes discrepancies in both directions:
 *   - md has [x] but sqlite has pending/in-progress → update sqlite to complete
 *   - sqlite has complete but md has [ ] → update md checkbox to [x]
 */
export function auditSpecCompletion(
  store: SpecStore,
  specId: string,
): AuditResult {
  const spec = store.getSpec(specId);
  if (!spec) {
    return {
      specId,
      totalTasks: 0,
      completeTasks: 0,
      fixes: [],
      inSync: true,
    };
  }

  // Re-parse the .md file to get current checkbox states
  const mdSpec = parsePlanFile(spec.planFile);
  const sqliteTasks = store.getTasksForSpec(specId);
  const fixes: AuditFix[] = [];

  // Build a map of sqlite tasks by position
  const sqliteByPos = new Map(sqliteTasks.map((t) => [t.position, t]));

  for (const mdTask of mdSpec.tasks) {
    const sqliteTask = sqliteByPos.get(mdTask.position);
    if (!sqliteTask) continue;

    const mdComplete = mdTask.status === "complete";
    const sqliteComplete = sqliteTask.status === "complete";

    if (mdComplete && !sqliteComplete) {
      // MD is ahead — update SQLite
      store.updateTaskStatus(specId, mdTask.position, "complete", {
        completedAt: Date.now(),
      });
      fixes.push({
        taskPosition: mdTask.position,
        taskTitle: mdTask.title,
        issue: "md-ahead",
        action: "updated-sqlite",
      });
    } else if (sqliteComplete && !mdComplete) {
      // SQLite is ahead — update MD file
      fixes.push({
        taskPosition: mdTask.position,
        taskTitle: sqliteTask.title,
        issue: "sqlite-ahead",
        action: "updated-md",
      });
    }
  }

  // If any sqlite-ahead fixes, rewrite the md file
  const sqliteAheadPositions = new Set(
    fixes.filter((f) => f.issue === "sqlite-ahead").map((f) => f.taskPosition),
  );
  if (sqliteAheadPositions.size > 0) {
    updateMdCheckboxes(spec.planFile, sqliteAheadPositions);
  }

  const finalTasks = store.getTasksForSpec(specId);
  const completeTasks = finalTasks.filter(
    (t) => t.status === "complete",
  ).length;

  return {
    specId,
    totalTasks: finalTasks.length,
    completeTasks,
    fixes,
    inSync: fixes.length === 0,
  };
}

/**
 * Rewrite a plan file's checkboxes: change `- [ ] Task N:` to `- [x] Task N:`
 * for the given task positions. Preserves all other content.
 */
function updateMdCheckboxes(planFile: string, positions: Set<number>): void {
  const content = readFileSync(planFile, "utf-8");
  const lines = content.split("\n");

  const updated = lines.map((line) => {
    // Match: `- [ ] Task N: Title` or `- [~] Task N: Title`
    const match = line.match(/^(-\s+)\[[ ~]\]\s+(Task\s+(\d+):.*)$/i);
    if (match) {
      const pos = parseInt(match[3], 10);
      if (positions.has(pos)) {
        return `${match[1]}[x] ${match[2]}`;
      }
    }
    return line;
  });

  writeFileSync(planFile, updated.join("\n"));
}
