/**
 * Plan header parsing — title, `Key: Value` / `**Key:** Value` metadata and
 * status normalization. Split out of `parser.ts` (which keeps task
 * extraction) purely for length; behaviour is unchanged.
 */

import type { SpecStatus } from "./types.js";
import { SPEC_STATUSES } from "./types.js";

export interface RawMetadata {
  status?: string;
  type?: string;
  approved?: string;
  created?: string;
  iterations?: string;
  worktree?: string;
  parent?: string;
  wave?: string;
  orchestration?: string;
}

/** Extract metadata from either new-format or old-format plan files. */
export function extractMetadata(
  lines: string[],
  fenced: boolean[],
): RawMetadata {
  const meta: RawMetadata = {};

  // Scan the first 20 lines for metadata (both formats)
  const scanLimit = Math.min(lines.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    if (fenced[i]) continue; // A fenced `Status:` line is documentation.
    const line = lines[i].trim();

    // New format: `Key: Value`
    const plainMatch = line.match(
      /^(Status|Type|Approved|Created|Iterations|Worktree|Parent|Wave|Orchestration):\s*(.+)$/i,
    );
    if (plainMatch) {
      const key = plainMatch[1].toLowerCase() as keyof RawMetadata;
      meta[key] = plainMatch[2].trim();
      continue;
    }

    // Old format: `**Key:** Value`
    const boldMatch = line.match(
      /^\*\*(Status|Type|Approved|Date|Created|Iterations|Worktree|Orchestration):\*\*\s*(.+)$/i,
    );
    if (boldMatch) {
      let key = boldMatch[1].toLowerCase();
      if (key === "date") key = "created";
      meta[key as keyof RawMetadata] = boldMatch[2].trim();
      continue;
    }

    // Stop at first heading after title (## Summary, ## Overview, etc.)
    if (i > 1 && line.startsWith("## ")) break;
  }

  return meta;
}

/** Extract the title from the first non-fenced `# heading` line. */
export function extractTitle(lines: string[], fenced: boolean[]): string {
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (fenced[i]) continue;
    const match = lines[i].match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return "Untitled";
}

export function normalizeStatus(raw: string | undefined): SpecStatus {
  if (!raw) return "PENDING";

  const upper = raw.toUpperCase().replace(/\s+/g, "_");

  // Direct match
  if (SPEC_STATUSES.includes(upper as SpecStatus)) return upper as SpecStatus;

  // Common aliases (IN_PROGRESS already covered by direct match above)
  if (upper === "DONE" || upper === "FINISHED") return "VERIFIED";

  return "PENDING";
}
