/**
 * Shared Memory
 *
 * Reads/writes `.sentinal/project-memory.json` — a human-editable,
 * committable file containing curated project observations shared
 * across team members.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Observation, ObservationType } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SharedObservation {
  type: ObservationType;
  title: string;
  content: string;
  tags: string[];
  filePaths: string[];
  createdAt: string;  // YYYY-MM-DD, human-friendly
  author?: string;
}

interface SharedMemoryFile {
  version: number;
  observations: SharedObservation[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SHARED_MEMORY_FILENAME = "project-memory.json";
const SENTINAL_DIR = ".sentinal";

// ─── Path Helper ──────────────────────────────────────────────────────────────

export function sharedMemoryPath(projectPath: string): string {
  return join(projectPath, SENTINAL_DIR, SHARED_MEMORY_FILENAME);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read shared observations from the project memory file.
 * Returns empty array on missing file or parse error. Never throws.
 */
export function readSharedMemory(projectPath: string): SharedObservation[] {
  const filePath = sharedMemoryPath(projectPath);
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Partial<SharedMemoryFile>;
    if (!Array.isArray(data.observations)) return [];
    return data.observations;
  } catch {
    return [];
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Write shared observations to the project memory file.
 * Creates `.sentinal/` directory if needed. Writes formatted JSON.
 */
export function writeSharedMemory(projectPath: string, observations: SharedObservation[]): void {
  const dir = join(projectPath, SENTINAL_DIR);
  mkdirSync(dir, { recursive: true });

  const data: SharedMemoryFile = { version: 1, observations };
  writeFileSync(sharedMemoryPath(projectPath), JSON.stringify(data, null, 2) + "\n", "utf-8");

  // Ensure .gitignore exists for shared memory discoverability
  ensureGitignore(dir);
}

/**
 * Add a single observation to shared memory. Deduplicates by title —
 * if an observation with the same title exists, it is replaced.
 */
export function addSharedObservation(projectPath: string, obs: SharedObservation): void {
  const existing = readSharedMemory(projectPath);
  const filtered = existing.filter((o) => o.title !== obs.title);
  filtered.push(obs);
  writeSharedMemory(projectPath, filtered);
}

// ─── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a SharedObservation to a full Observation for use in restoreContext().
 * Uses negative IDs (starting from -1) to distinguish from SQLite observations.
 */
export function toObservation(
  shared: SharedObservation,
  projectPath: string,
  index: number,
): Observation {
  // Parse createdAt date string to timestamp
  let timestamp: number;
  try {
    timestamp = new Date(shared.createdAt).getTime();
    if (Number.isNaN(timestamp)) timestamp = Date.now();
  } catch {
    timestamp = Date.now();
  }

  return {
    id: -(index + 1),
    sessionId: "shared",
    projectPath,
    timestamp,
    type: shared.type,
    title: shared.title,
    content: shared.content,
    filePaths: shared.filePaths ?? [],
    tags: shared.tags ?? [],
    metadata: { source: "shared" },
    qualityScore: 1.0,
  };
}

// ─── Shared Save Helper ───────────────────────────────────────────────────────

const SHAREABLE_TYPES = new Set(["decision", "discovery", "pattern"]);

interface SharedSaveOptions {
  project: string;
  type: string;
  title: string;
  content: string;
  tags?: string[];
  filePaths?: string[];
  shared?: boolean;
}

/**
 * Save observation to shared memory if `shared` is true and type is allowed.
 * Only decision, discovery, and pattern types can be shared.
 * Returns true if saved, false if skipped.
 */
export async function saveToSharedIfRequested(opts: SharedSaveOptions): Promise<boolean> {
  if (!opts.shared) return false;
  if (!SHAREABLE_TYPES.has(opts.type)) return false;

  let author = "unknown";
  try {
    const proc = Bun.spawn(["git", "config", "user.name"], {
      cwd: opts.project,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    if (text.trim()) author = text.trim();
  } catch { /* git unavailable */ }

  addSharedObservation(opts.project, {
    type: opts.type as ObservationType,
    title: opts.title,
    content: opts.content,
    tags: opts.tags ?? [],
    filePaths: opts.filePaths ?? [],
    createdAt: new Date().toISOString().split("T")[0],
    author,
  });

  return true;
}

// ─── MCP Tool Registration ───────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "./service.js";
import type { SidecarClient } from "../sidecar/client.js";
import { OBSERVATION_TYPES } from "./types.js";

export interface SharedToolsDeps {
  client?: SidecarClient | null;
  service?: MemoryService | null;
}

export function registerSharedTools(server: McpServer, deps: SharedToolsDeps): void {
  const { client = null, service = null } = deps;

  server.tool(
    "memory_share",
    "Promote existing observations to shared project memory (.sentinal/project-memory.json). Only decision, discovery, and pattern types are allowed.",
    {
      ids: z.array(z.number()).min(1).max(20).describe("Observation IDs to promote"),
      project: z.string().describe("Project root path"),
    },
    async ({ ids, project }) => {
      const observations = client
        ? await client.memoryGet(ids)
        : service?.getObservations(ids) ?? [];

      if (observations.length === 0) {
        return { content: [{ type: "text", text: "No observations found for the given IDs." }] };
      }

      let shared = 0;
      let rejected = 0;
      for (const obs of observations) {
        if (!SHAREABLE_TYPES.has(obs.type)) {
          rejected++;
          continue;
        }
        addSharedObservation(project, {
          type: obs.type as ObservationType,
          title: obs.title,
          content: obs.content,
          tags: obs.tags ?? [],
          filePaths: obs.filePaths ?? [],
          createdAt: new Date(obs.timestamp).toISOString().split("T")[0],
          author: obs.metadata?.author as string | undefined,
        });
        shared++;
      }

      const parts = [`Promoted ${shared} observation(s) to shared project memory.`];
      if (rejected > 0) parts.push(`Rejected ${rejected} (only decision/discovery/pattern types allowed).`);
      return { content: [{ type: "text", text: parts.join(" ") }] };
    },
  );
}

// ─── Gitignore ────────────────────────────────────────────────────────────────

const GITIGNORE_CONTENT = `# Ignore everything in .sentinal/ except shared project memory
*
!.gitignore
!project-memory.json
`;

function ensureGitignore(sentinalDir: string): void {
  const gitignorePath = join(sentinalDir, ".gitignore");
  if (existsSync(gitignorePath)) return;
  writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf-8");
}
