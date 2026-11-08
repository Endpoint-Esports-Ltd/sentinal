/**
 * `memory_search({scope: "related"})` fan-out
 * (docs/plans/2026-11-05-cross-project-scope-phase-2.md, Task 2).
 *
 * One search per project — the base project plus every `related.json` entry
 * that exists — each already relevance-ranked by the store/sidecar. The
 * results carry no comparable score across searches, so they are merged by
 * ROUND-ROBIN over the per-project lists, de-duplicated by id and truncated.
 * Works against any sidecar: it only calls the existing `/memory/search`.
 */

import { basename } from "node:path";
import type { RelatedProjectsResult } from "../project/related.js";

/** Interleave ranked lists (first of each, then second of each, …), dedupe by id. */
export function mergeRoundRobin<T extends { id: number }>(
  lists: T[][],
  limit: number,
): T[] {
  const out: T[] = [];
  const seen = new Set<number>();
  const longest = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface SearchRelatedInput<T extends { id: number }> {
  /** The caller's project path (any checkout/subdirectory). */
  base: string;
  limit: number;
  /** One project's ranked results; `project` is a storage key. */
  search: (project: string) => Promise<T[]>;
  identityOf: (path: string) => string;
  workspaceOf: (path: string) => string;
  loadRelated: (workspace: string) => RelatedProjectsResult;
}

export interface SearchRelatedOutput<T> {
  results: Array<T & { project: string }>;
  warnings: string[];
}

export async function searchRelated<T extends { id: number }>(
  input: SearchRelatedInput<T>,
): Promise<SearchRelatedOutput<T>> {
  const workspace = input.workspaceOf(input.base);
  const related = input.loadRelated(workspace);
  const targets = [
    { identity: input.identityOf(input.base), name: basename(workspace) },
    ...related.projects
      .filter((p) => p.exists)
      .map((p) => ({ identity: p.identity, name: p.name })),
  ];
  const warnings = [...related.warnings];
  const lists = await Promise.all(
    targets.map(async (t) => {
      try {
        const rows = await input.search(t.identity);
        return rows.map((r) => ({ ...r, project: t.name }));
      } catch (err) {
        warnings.push(
          `search in ${t.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    }),
  );
  return { results: mergeRoundRobin(lists, input.limit), warnings };
}
