/**
 * Pre-Edit Guidance Hook
 *
 * Injects file-specific memory observations as context before Write/Edit/MultiEdit.
 * Only fires when relevant observations exist for the target file (silent otherwise).
 *
 * Query strategy: use memory search with the file basename as query,
 * then filter client-side to observations whose filePaths match the target.
 *
 * Both the search and the file-conflict check are keyed by the EDITED FILE's
 * project (cross-project scope, Phase 1): observations are written under the
 * file's identity, so a session in A editing B/x.ts must read B's rows.
 */

import { basename, resolve } from "node:path";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { isMemoryEnabled } from "../memory/config.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SidecarClient } from "../sidecar/client.js";
import { detectFileConflict } from "../session/conflict.js";
import {
  resolveFileProject,
  sessionRootsFromCwd,
} from "../project/file-project.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreEditInput {
  filePath: string;
  cwd: string;
  /** Effort level from HookInput.effort.level — controls observation count */
  effort?: string;
  /** Direct service (for testing / fallback) */
  service?: MemoryService;
  /** Sidecar client (preferred path) */
  client?: SidecarClient | null;
  /**
   * Canonical identity of the project to search. Default: the edited file's
   * project, resolved from `cwd` + `filePath`.
   */
  project?: string;
}

interface SearchHit {
  id: number;
  title: string;
  type: string;
  timestamp: number;
  filePaths: string[];
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Query memory for observations related to the target file.
 * Returns a formatted hint string, or null if no relevant observations exist.
 */
export async function processPreEditGuide(
  input: PreEditInput,
): Promise<string | null> {
  const { filePath, cwd } = input;
  const fileBasename = basename(filePath);
  // STORAGE KEY — canonical, so the direct fallback (exact-match read) also
  // finds rows from a subdirectory or linked worktree.
  const project = input.project ?? fileProjectOf(filePath, cwd).identity;

  let hits: SearchHit[] = [];

  if (input.client) {
    // Sidecar path
    try {
      const results = await input.client.memorySearch({
        query: fileBasename,
        project,
        limit: 10,
      });
      hits = results as SearchHit[];
    } catch {
      // Sidecar unavailable — try direct
      hits = await searchDirect(fileBasename, project, input.service);
    }
  } else if (input.service) {
    // Direct service path (testing / fallback)
    hits = await searchDirect(fileBasename, project, input.service);
  } else {
    // No client or service — open store
    let store: MemoryStore | null = null;
    try {
      store = new MemoryStore();
      const service = new MemoryService(store);
      hits = await searchDirect(fileBasename, project, service);
    } catch {
      // Memory unavailable
    } finally {
      store?.close();
    }
  }

  // Client-side filter: only keep observations whose filePaths contain the target
  const relevant = hits.filter((h) =>
    h.filePaths?.some(
      (fp) => fp === filePath || filePath.endsWith(fp) || fp.endsWith(filePath),
    ),
  );

  if (relevant.length === 0) return null;

  const maxHits = input.effort === "low" || input.effort === "medium" ? 3 : 5;

  return formatHint(fileBasename, relevant, maxHits);
}

// ─── Hook context (conflict + guidance) ───────────────────────────────────────

/** The edited file's project, from the hook's cwd (relative paths resolve there). */
function fileProjectOf(filePath: string, cwd: string) {
  return resolveFileProject(resolve(cwd, filePath), sessionRootsFromCwd(cwd));
}

export interface PreEditHookInput {
  filePath: string;
  cwd: string;
  sessionId?: string;
  client: SidecarClient | null;
  effort?: string;
  /** File-conflict check; default: `detectFileConflict` over the default store. */
  checkConflict?: (
    filePath: string,
    projectPath: string,
    sessionId: string,
  ) => string | null;
}

function defaultConflictCheck(
  filePath: string,
  projectPath: string,
  sessionId: string,
): string | null {
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore();
    return (
      detectFileConflict(store, filePath, projectPath, sessionId)?.message ??
      null
    );
  } catch {
    return null; // non-fatal
  } finally {
    store?.close();
  }
}

/**
 * Everything `sentinal hook shared pre-edit-guide` says before an edit: the
 * file-conflict warning (needs a session id) and the memory hint, both keyed
 * by the file's project (resolved once).
 */
export async function preEditHookContext(
  input: PreEditHookInput,
): Promise<string | null> {
  const { filePath, cwd, sessionId } = input;
  const project = fileProjectOf(filePath, cwd).identity;
  const parts: string[] = [];
  if (sessionId) {
    const check = input.checkConflict ?? defaultConflictCheck;
    const conflict = check(filePath, project, sessionId);
    if (conflict) parts.push(conflict);
  }
  const guide = await processPreEditGuide({
    filePath,
    cwd,
    client: input.client,
    effort: input.effort,
    project,
  });
  if (guide) parts.push(guide);
  return parts.length > 0 ? parts.join("\n") : null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function searchDirect(
  _query: string,
  project: string,
  service?: MemoryService,
): Promise<SearchHit[]> {
  if (!service) return [];
  try {
    // Get recent observations for the project and let caller filter by filePath
    const observations = service.getRecentForProject(project, 50);
    return observations.map((o) => ({
      id: o.id,
      title: o.title,
      type: o.type,
      timestamp: o.timestamp,
      filePaths: o.filePaths,
    }));
  } catch {
    return [];
  }
}

function formatHint(filename: string, hits: SearchHit[], maxHits = 5): string {
  const lines = [`[Sentinal] Context for ${filename}:`];

  for (const hit of hits.slice(0, maxHits)) {
    const date = new Date(hit.timestamp).toISOString().split("T")[0];
    lines.push(`- [${hit.type}] ${date}: ${hit.title}`);
  }

  if (hits.length > maxHits) {
    lines.push(`  ... and ${hits.length - maxHits} more observation(s)`);
  }

  return lines.join("\n");
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isMemoryEnabled()) return;

  const input = await readStdin();
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const filePath =
    (toolInput?.file_path as string) ??
    (toolInput?.filePath as string) ??
    (toolInput?.path as string);
  if (!filePath) return;

  let client: SidecarClient | null = null;
  try {
    client = await SidecarClient.connect();
  } catch {
    /* sidecar unavailable */
  }

  const result = await processPreEditGuide({
    filePath,
    cwd: input.cwd,
    client,
    effort: input.effort?.level,
  });
  if (result) output(hint("PreToolUse", result));
}

if (import.meta.main) {
  main().catch(() => {});
}
