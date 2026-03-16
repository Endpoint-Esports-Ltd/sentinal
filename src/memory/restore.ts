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

import { basename } from "node:path";
import type { MemoryService } from "./service.js";
import type { Observation, ObservationType } from "./types.js";
import { findActivePlan } from "../spec/detect.js";
import { readSharedMemory, toObservation } from "./shared.js";

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
  /** Semantic query for hybrid search. When provided, restoreContext returns a Promise. */
  semanticQuery?: string;
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
 *
 * When `semanticQuery` is provided, performs async hybrid search.
 * When omitted, uses synchronous chronological fetch wrapped in Promise.
 * Always returns Promise<RestoredContext> for consistent API.
 */
export async function restoreContext(
  service: MemoryService,
  options: RestoreOptions,
): Promise<RestoredContext> {
  if (options.semanticQuery) {
    return restoreContextAsync(service, options);
  }
  return restoreContextSync(service, options);
}

async function restoreContextAsync(
  service: MemoryService,
  options: RestoreOptions,
): Promise<RestoredContext> {
  const recentLimit = options.recentLimit ?? DEFAULTS.recentLimit;
  const SEMANTIC_TIMEOUT = 2000; // 2s timeout for embedding + search

  let recent: Observation[];

  try {
    // Try semantic search with timeout
    const searchPromise = service.search(options.semanticQuery!, {
      project: options.projectPath,
      limit: recentLimit * 2, // over-fetch to account for dedup
    });

    const results = await Promise.race([
      searchPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEMANTIC_TIMEOUT)),
    ]);

    if (results && results.length > 0) {
      // Fetch full observations from search result IDs
      const ids = results.map((r) => r.id);
      recent = service.getObservations(ids);

      // Supplement if sparse: add chronological results not already in semantic set
      if (recent.length < 3) {
        const chronological = service.getRecentForProject(options.projectPath, recentLimit);
        const existingIds = new Set(recent.map((o) => o.id));
        for (const obs of chronological) {
          if (!existingIds.has(obs.id)) {
            recent.push(obs);
            if (recent.length >= recentLimit) break;
          }
        }
      }
    } else {
      // Semantic search returned nothing or timed out — fall back
      recent = service.getRecentForProject(options.projectPath, recentLimit);
    }
  } catch {
    // Search failed — fall back to chronological
    recent = service.getRecentForProject(options.projectPath, recentLimit);
  }

  const merged = mergeSharedObservations(recent, options.projectPath);

  if (merged.length === 0) {
    return { markdown: "", observationCount: 0, hasMemory: false };
  }

  return buildRestoreMarkdown(service, options, merged);
}

function restoreContextSync(
  service: MemoryService,
  options: RestoreOptions,
): RestoredContext {
  const recentLimit = options.recentLimit ?? DEFAULTS.recentLimit;

  const recent = service.getRecentForProject(options.projectPath, recentLimit);
  const merged = mergeSharedObservations(recent, options.projectPath);

  if (merged.length === 0) {
    return { markdown: "", observationCount: 0, hasMemory: false };
  }

  return buildRestoreMarkdown(service, options, merged);
}

const MAX_SHARED_OBSERVATIONS = 15;

/** Merge shared observations from .sentinal/project-memory.json with SQLite observations */
function mergeSharedObservations(sqliteObs: Observation[], projectPath: string): Observation[] {
  const shared = readSharedMemory(projectPath);
  if (shared.length === 0) return sqliteObs;

  const existingTitles = new Set(sqliteObs.map((o) => o.title));
  const deduped = shared.filter((s) => !existingTitles.has(s.title));
  const truncated = deduped.length > MAX_SHARED_OBSERVATIONS;
  const converted = deduped
    .slice(0, MAX_SHARED_OBSERVATIONS)
    .map((s, i) => toObservation(s, projectPath, i));

  if (truncated) {
    converted.push({
      id: -(converted.length + 1),
      sessionId: "shared",
      projectPath,
      timestamp: Date.now(),
      type: "discovery",
      title: `Showing ${MAX_SHARED_OBSERVATIONS} of ${deduped.length} shared observations`,
      content: `${deduped.length - MAX_SHARED_OBSERVATIONS} additional shared observations were omitted. See .sentinal/project-memory.json for the full list.`,
      filePaths: [],
      tags: ["shared-memory"],
      metadata: { source: "shared" },
      qualityScore: 1.0,
    });
  }

  return [...sqliteObs, ...converted];
}

function buildRestoreMarkdown(
  service: MemoryService,
  options: RestoreOptions,
  recent: Observation[],
): RestoredContext {
  const decisionWindowMs = options.decisionWindowMs ?? DEFAULTS.decisionWindowMs;
  const maxOutputLength = options.maxOutputLength ?? DEFAULTS.maxOutputLength;

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

// ─── Semantic Query Builder ───────────────────────────────────────────────────

/**
 * Build a semantic query string for memory restore.
 * Uses active spec task (primary), falls back to recent files + project name.
 * ALWAYS returns a non-empty string (project basename is the minimum).
 */
export function buildSemanticQuery(projectPath: string, service?: MemoryService): string {
  const parts: string[] = [];

  // 1. Active spec task (highest priority)
  try {
    const active = findActivePlan(projectPath);
    if (active?.spec.tasks) {
      const currentTask = active.spec.tasks.find((t) => t.status === "pending" || t.status === "in-progress");
      if (currentTask) {
        parts.push(currentTask.title);
        if (currentTask.description) parts.push(currentTask.description);
      } else {
        // No pending task — use spec title
        parts.push(active.spec.title);
      }
    }
  } catch { /* spec detection failed — continue */ }

  // 2. Recent files (fallback or supplement)
  if (parts.length === 0 && service) {
    try {
      const recent = service.getRecentForProject(projectPath, 5);
      const files = new Set<string>();
      for (const obs of recent) {
        for (const fp of obs.filePaths) files.add(fp);
      }
      if (files.size > 0) {
        parts.push("Recent work on: " + [...files].slice(0, 10).join(", "));
      }
    } catch { /* service query failed — continue */ }
  }

  // 3. Minimum fallback: project basename (NEVER return empty)
  if (parts.length === 0) {
    parts.push(basename(projectPath));
  }

  return parts.join(". ").slice(0, 500);
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
