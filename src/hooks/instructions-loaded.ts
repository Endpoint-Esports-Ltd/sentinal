/**
 * Instructions Loaded Hook (Claude Code)
 *
 * Fires on the InstructionsLoaded event to record which rules/instructions
 * files were loaded per session. Powers /sync decisions.
 *
 * Only captures when load_reason is "session_start" or "path_glob_match".
 * All other reasons (nested_traversal, include, compact) are skipped.
 *
 * This hook is async (fire-and-forget). Sidecar preferred; silent no-op
 * if unavailable.
 *
 * Deduplication (H9): repeat loads of the same file in the same project
 * TOUCH the existing observation instead of appending a new row per
 * session. There is no exact-lookup client route, so we run a ranked
 * memorySearch scoped to {project, type: "discovery"} and apply an exact
 * title-equality filter over EVERY returned row (ranking order is not
 * guaranteed). No recency window: a touch is a content-only
 * updateObservation, which refreshes timestamp + quality_score in the
 * store, so a match is never stale — a window would just re-create one
 * duplicate per window period. If the dedup search itself fails, we fall
 * through to insert: availability of the observation beats dedup (worst
 * case is one extra row, which the next successful search dedups against).
 */

import { basename } from "node:path";
import { readStdin } from "../utils/hook-output.js";
import { SidecarClient } from "../sidecar/client.js";
import type { HookInput } from "../utils/hook-output.js";

/** Load reasons that warrant capturing an observation. */
const CAPTURE_REASONS = new Set(["session_start", "path_glob_match"]);

/**
 * Find an existing "Instructions loaded" observation with this exact title
 * in this project. Returns its id, or null (including on search failure —
 * see the module docstring for why failure falls through to insert).
 */
async function findExistingObservation(
  client: SidecarClient,
  title: string,
  projectPath: string,
): Promise<number | null> {
  try {
    const results = await client.memorySearch({
      query: title,
      project: projectPath, // project equality enforced server-side
      type: "discovery",
      limit: 10,
    });
    const match = (results ?? []).find(
      (r: { id: number; title: string }) => r?.title === title,
    );
    if (!match) return null;

    // ⛔ Ownership guard: SearchResult carries no project field, so the title
    // match above relies entirely on the server-side `project` filter. Titles
    // like "Instructions loaded: CLAUDE.md" are identical across every
    // project — if that filter ever regressed, we would TOUCH another
    // project's observation. Confirm ownership via memoryGet (which returns
    // the full row incl. projectPath) before treating it as a duplicate.
    // Any uncertainty → insert (availability beats dedup; worst case is one
    // extra row the next successful pass dedups against).
    const rows = await client.memoryGet([match.id]);
    const row = rows?.[0] as { projectPath?: string } | undefined;
    return row?.projectPath === projectPath ? match.id : null;
  } catch {
    return null;
  }
}

/**
 * Process an InstructionsLoaded hook event.
 * Records which instructions file was loaded as a memory observation.
 */
export async function processInstructionsLoaded(
  input: HookInput,
): Promise<void> {
  const { load_reason, file_path, memory_type, cwd, session_id } = input;

  // Only capture for relevant load reasons
  if (!load_reason || !CAPTURE_REASONS.has(load_reason)) {
    return;
  }

  if (!file_path) {
    return;
  }

  // Try sidecar — silent no-op if unavailable
  try {
    const client = await SidecarClient.connect();
    if (!client) return;

    const title = `Instructions loaded: ${basename(file_path)}`;
    const content = `File: ${file_path}\nMemory type: ${memory_type ?? "unknown"}\nLoad reason: ${load_reason}`;

    const existingId = await findExistingObservation(client, title, cwd);
    if (existingId != null) {
      // Touch: content-only update refreshes timestamp/staleness so the
      // /sync signal stays fresh without appending a duplicate row.
      await client.updateObservation({ id: existingId, content });
      return;
    }

    await client.addObservation({
      sessionId: session_id,
      projectPath: cwd,
      type: "discovery",
      title,
      content,
      tags: ["instructions", "rules", load_reason],
    });
  } catch {
    // Sidecar failure is non-fatal for async hooks
  }
}

// ─── Claude Code Hook Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    await processInstructionsLoaded(input);
  } catch {
    // Non-fatal — async hooks cannot block
  }
}

if (import.meta.main) {
  main().catch(() => {});
}
