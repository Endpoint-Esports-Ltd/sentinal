/**
 * Spec Detection
 *
 * Utilities for finding active plan files and detecting spec type.
 * Used by hooks (spec-stop-guard, pre-compact) and CLI commands.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlanFile } from "./parser.js";
import { ACTIVE_STATUSES } from "./types.js";
import type { Spec, SpecStatus, SpecType } from "./types.js";

// --- Active Plan Detection ---

export interface ActivePlan {
  filePath: string;
  spec: Spec;
}

/**
 * Find the most recent active (non-terminal) plan in `docs/plans/`.
 * Plans are sorted reverse-alphabetically so date-prefixed files come first.
 */
export function findActivePlan(searchDir: string): ActivePlan | null {
  const plansDir = join(searchDir, "docs", "plans");
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (const file of files) {
      const filePath = join(plansDir, file);
      const spec = parsePlanFile(filePath);
      if (ACTIVE_STATUSES.includes(spec.status)) {
        return { filePath, spec };
      }
    }
  } catch {
    return null;
  }

  return null;
}

// --- Stop Guard Logic ---

/**
 * Determine if the agent should be blocked from stopping based on active spec status.
 * Returns a human-readable reason string if stopping should be blocked, or null if OK to stop.
 */
export function shouldBlockStop(status: SpecStatus | null): string | null {
  if (!status) return null;
  if (status === "PENDING") return `Active spec plan is PENDING (awaiting implementation). Resume with /spec <plan-path>. Do NOT stop.`;
  if (status === "COMPLETE") return `Active spec plan is COMPLETE (awaiting verification). Run verification phase. Do NOT stop.`;
  return null;
}

// --- Spec Type Detection ---

const BUGFIX_PATTERNS = [
  /\bfix\b/i,
  /\bbug\b/i,
  /\bpatch\b/i,
  /\bresolve[sd]?\b/i,
  /\bhotfix\b/i,
  /\bregression\b/i,
  /\bdefect\b/i,
];

/**
 * Detect whether a spec is a feature or bugfix based on title and content.
 * Uses regex scoring: 2+ bugfix keyword hits → bugfix, else feature.
 */
export function detectSpecType(title: string, content: string): SpecType {
  const text = `${title}\n${content.slice(0, 500)}`;
  let score = 0;

  for (const pattern of BUGFIX_PATTERNS) {
    if (pattern.test(text)) score++;
  }

  return score >= 2 ? "bugfix" : "feature";
}
