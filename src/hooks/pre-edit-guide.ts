/**
 * Pre-Edit Guidance Hook
 *
 * Injects file-specific memory observations as context before Write/Edit/MultiEdit.
 * Only fires when relevant observations exist for the target file (silent otherwise).
 *
 * Query strategy: use memory search with the file basename as query,
 * then filter client-side to observations whose filePaths match the target.
 */

import { basename } from "node:path";
import { readStdin, hint, output } from "../utils/hook-output.js";
import { isMemoryEnabled } from "../memory/config.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SidecarClient } from "../sidecar/client.js";
import { detectFileConflict } from "../session/conflict.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreEditInput {
  filePath: string;
  cwd: string;
  /** Direct service (for testing / fallback) */
  service?: MemoryService;
  /** Sidecar client (preferred path) */
  client?: SidecarClient | null;
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

  let hits: SearchHit[] = [];

  if (input.client) {
    // Sidecar path
    try {
      const results = await input.client.memorySearch({
        query: fileBasename,
        project: cwd,
        limit: 10,
      });
      hits = results as SearchHit[];
    } catch {
      // Sidecar unavailable — try direct
      hits = await searchDirect(fileBasename, cwd, input.service);
    }
  } else if (input.service) {
    // Direct service path (testing / fallback)
    hits = await searchDirect(fileBasename, cwd, input.service);
  } else {
    // No client or service — open store
    let store: MemoryStore | null = null;
    try {
      store = new MemoryStore();
      const service = new MemoryService(store);
      hits = await searchDirect(fileBasename, cwd, service);
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

  return formatHint(fileBasename, relevant);
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

function formatHint(filename: string, hits: SearchHit[]): string {
  const lines = [`[Sentinal] Context for ${filename}:`];

  for (const hit of hits.slice(0, 5)) {
    const date = new Date(hit.timestamp).toISOString().split("T")[0];
    lines.push(`- [${hit.type}] ${date}: ${hit.title}`);
  }

  if (hits.length > 5) {
    lines.push(`  ... and ${hits.length - 5} more observation(s)`);
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
  });
  if (result) output(hint("PreToolUse", result));
}

if (import.meta.main) {
  main().catch(() => {});
}
