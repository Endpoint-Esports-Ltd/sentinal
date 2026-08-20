/**
 * `git diff --numstat` parsing.
 *
 * Extracted verbatim from `manager.ts`, which sits against Sentinal's 600-line
 * hard block (R4).
 */

import type { DiffSummary, DiffFileSummary } from "./types.js";

/** Parse `git diff --numstat` output into a {@link DiffSummary}. */
export function parseNumstat(output: string): DiffSummary {
  const files: DiffFileSummary[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of output.split("\n")) {
    // numstat lines: "10\t5\tsrc/file.ts" or "-\t-\tbinary-file"
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;

    const insertions = match[1] === "-" ? 0 : parseInt(match[1]);
    const deletions = match[2] === "-" ? 0 : parseInt(match[2]);
    const path = match[3];

    // Detect renamed files: "old => new" or "{old => new}/rest"
    const isRenamed = path.includes(" => ");
    let status: DiffFileSummary["status"];
    if (isRenamed) {
      status = "renamed";
    } else if (insertions > 0 && deletions === 0) {
      status = "added";
    } else if (insertions === 0 && deletions > 0) {
      status = "deleted";
    } else {
      status = "modified";
    }

    files.push({ path, status, insertions, deletions });
    totalInsertions += insertions;
    totalDeletions += deletions;
  }

  return {
    filesChanged: files.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    files,
  };
}
