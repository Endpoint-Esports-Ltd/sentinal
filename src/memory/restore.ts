/**
 * Context Restoration
 *
 * Generates a compact context block from memory to inject at session start.
 * Used by both Claude Code hooks and OpenCode plugin.
 *
 * Restoration strategy (from plan):
 * 1. Last 10 observations from the same project
 * 2. Key decisions from past 30 days
 * 3. Error patterns (recent errors/fixes)
 */

import type { MemoryService } from "./service.js";
import type { Observation, ObservationType } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RestoreOptions {
  /** Project path to restore context for */
  projectPath: string;
  /** Maximum number of recent observations */
  recentLimit?: number;
  /** How far back to look for decisions (ms) */
  decisionWindowMs?: number;
  /** Maximum total output length (characters) */
  maxOutputLength?: number;
  /** Current files being worked on — surfaces relevant errors/fixes */
  currentFiles?: string[];
}

export interface RestoredContext {
  /** Formatted markdown context block */
  markdown: string;
  /** Number of observations included */
  observationCount: number;
  /** Whether this project has any memory at all */
  hasMemory: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  recentLimit: 10,
  decisionWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxOutputLength: 3000,
} as const;

// ─── Restore ──────────────────────────────────────────────────────────────────

/**
 * Generate a compact context block from memory for session injection.
 * Returns formatted markdown suitable for a system prompt.
 */
export function restoreContext(
  service: MemoryService,
  options: RestoreOptions,
): RestoredContext {
  const recentLimit = options.recentLimit ?? DEFAULTS.recentLimit;
  const decisionWindowMs =
    options.decisionWindowMs ?? DEFAULTS.decisionWindowMs;
  const maxOutputLength =
    options.maxOutputLength ?? DEFAULTS.maxOutputLength;

  // 1. Get recent observations for this project
  const recent = service.getRecentForProject(
    options.projectPath,
    recentLimit,
  );

  if (recent.length === 0) {
    return { markdown: "", observationCount: 0, hasMemory: false };
  }

  // 2. Categorize observations
  const decisions = recent.filter((o) => o.type === "decision");
  const discoveries = recent.filter((o) => o.type === "discovery");
  const patterns = recent.filter((o) => o.type === "pattern");
  const errors = recent.filter((o) => o.type === "error");
  const fixes = recent.filter((o) => o.type === "fix");

  // 3. Also fetch key decisions from the wider window that may not be in recent
  const now = Date.now();
  const olderDecisions = service
    .searchSync("", {
      project: options.projectPath,
      type: "decision",
      dateStart: now - decisionWindowMs,
      limit: 5,
    })
    .filter(
      (r) => !decisions.some((d) => d.id === r.id),
    );

  // 4. Build markdown
  const sections: string[] = [];

  sections.push(`## Sentinal Memory Context`);
  sections.push("");
  sections.push(`**Project:** ${options.projectPath}`);

  const oldestTs = recent[recent.length - 1]?.timestamp;
  const newestTs = recent[0]?.timestamp;
  if (oldestTs && newestTs) {
    sections.push(
      `**Memory Range:** ${formatDate(oldestTs)} to ${formatDate(newestTs)}`,
    );
  }

  // Key Decisions
  const allDecisions = [
    ...decisions,
    ...olderDecisions.map((r) => ({
      ...findByIdInRecent(recent, r.id),
      id: r.id,
      title: r.title,
      timestamp: r.timestamp,
      type: "decision" as ObservationType,
    })),
  ];

  if (allDecisions.length > 0) {
    sections.push("");
    sections.push("### Key Decisions");
    for (const d of allDecisions.slice(0, 5)) {
      sections.push(`- ${d.title} (${formatDate(d.timestamp)})`);
    }
  }

  // Recent Discoveries
  if (discoveries.length > 0) {
    sections.push("");
    sections.push("### Recent Discoveries");
    for (const d of discoveries.slice(0, 5)) {
      sections.push(`- ${d.title} (${formatDate(d.timestamp)})`);
    }
  }

  // Patterns
  if (patterns.length > 0) {
    sections.push("");
    sections.push("### Patterns");
    for (const p of patterns.slice(0, 3)) {
      sections.push(`- ${p.title}`);
    }
  }

  // Active Issues (recent errors without corresponding fixes)
  const unresolvedErrors = errors.filter(
    (e) =>
      !fixes.some(
        (f) =>
          f.timestamp > e.timestamp &&
          f.filePaths.some((fp) => e.filePaths.includes(fp)),
      ),
  );

  if (unresolvedErrors.length > 0) {
    sections.push("");
    sections.push("### Active Issues");
    for (const e of unresolvedErrors.slice(0, 3)) {
      sections.push(`- ${e.title} (${formatDate(e.timestamp)})`);
    }
  }

  // Recent Fixes
  if (fixes.length > 0) {
    sections.push("");
    sections.push("### Recent Fixes");
    for (const f of fixes.slice(0, 3)) {
      sections.push(`- ${f.title} (${formatDate(f.timestamp)})`);
    }
  }

  // File-context-aware: surface errors/fixes related to current files
  if (options.currentFiles && options.currentFiles.length > 0) {
    const currentFileSet = new Set(
      options.currentFiles.map((f) => normalizeFilePath(f)),
    );

    const relatedObs = recent.filter(
      (o) =>
        (o.type === "error" || o.type === "fix" || o.type === "discovery") &&
        o.filePaths.some((fp) => currentFileSet.has(normalizeFilePath(fp))),
    );

    // Exclude observations already shown in other sections
    const shownIds = new Set([
      ...decisions.map((d) => d.id),
      ...discoveries.map((d) => d.id),
      ...unresolvedErrors.map((e) => e.id),
      ...fixes.map((f) => f.id),
    ]);
    const uniqueRelated = relatedObs.filter((o) => !shownIds.has(o.id));

    if (uniqueRelated.length > 0) {
      sections.push("");
      sections.push("### Related to Current Files");
      for (const o of uniqueRelated.slice(0, 5)) {
        sections.push(
          `- [${o.type}] ${o.title} (${formatDate(o.timestamp)})`,
        );
      }
    }
  }

  let markdown = sections.join("\n");

  // Truncate if too long
  if (markdown.length > maxOutputLength) {
    markdown =
      markdown.slice(0, maxOutputLength - 20) + "\n\n*(truncated)*";
  }

  return {
    markdown,
    observationCount: recent.length,
    hasMemory: true,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

function normalizeFilePath(filePath: string): string {
  // Normalize to just the relative path portion for matching
  return filePath.replace(/^\.\//, "").replace(/\\/g, "/");
}

function findByIdInRecent(
  recent: Observation[],
  id: number,
): Partial<Observation> {
  return recent.find((o) => o.id === id) ?? {};
}
