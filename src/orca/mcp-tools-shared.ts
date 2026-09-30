/**
 * Shared plumbing for the `orca_*` MCP tools (`mcp-tools.ts`,
 * `mcp-tools-settle.ts`): dependencies, the small in-process state the tools
 * share, and the response format — Markdown for the reader followed by ONE
 * fenced JSON block of the structured result, so skills read ids reliably.
 */

import { mcpText } from "../mcp/helpers.js";
import type { MemoryStore } from "../memory/store.js";
import type { SidecarClient } from "../sidecar/client.js";
import type { OrcaError, OrcaRunner } from "./cli.js";
import type { PrewarmClock } from "./dispatch-prewarm.js";
import type { StartTaskResult } from "./dispatch.js";
import type { StallVerdict } from "./stall.js";

export interface OrcaToolsDeps {
  /** ⛔ Deliberately unused — the Orca domain is direct-only (see mcp-tools.ts). */
  client?: SidecarClient | null;
  /** ⛔ Deliberately unused — the Orca domain is direct-only (see mcp-tools.ts). */
  store?: MemoryStore | null;
  /** Default: the real `orca` from PATH. Tests inject a fake. */
  runner?: OrcaRunner;
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Clock for stall ages. */
  now?: () => number;
  /** How long one `orca_start` call may wait before answering `pending`. */
  startBudgetMs?: number;
  /** Tests: an instant clock for the pre-warm readiness poll. */
  prewarmClock?: PrewarmClock;
  /**
   * Veto for `orca_remove_worktree`: refuse the main checkout, the calling
   * session's own checkout, and any worktree Sentinal still holds live. The
   * server injects `guardOrcaWorktreeRemoval` (src/worktree) — src/orca stays
   * free of git and store imports.
   */
  guardWorktreeRemoval?: (
    path: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface VerdictEntry {
  runId: string;
  evidenceId: string;
  verdict: StallVerdict;
}

/** Per-registration (per MCP server process) memory. Lost on restart by design. */
export interface OrcaToolState {
  /** request_id → a `startTask` still running in this process. */
  inflightStarts: Map<string, Promise<StartTaskResult>>;
  /** request_id → a start that finished after its caller got `pending`. */
  finishedStarts: Map<string, StartTaskResult>;
  /** dispatch_id → the latest positive stall verdict (only these authorize a stop). */
  verdicts: Map<string, VerdictEntry>;
  /** delivery_id → run_id, so `orca_ack` needs only the delivery. */
  deliveries: Map<string, string>;
  /**
   * Dispatches this session already released — its record that a worker_done
   * was processed. Orca re-sends an un-acked delivery, so a later orca_wait
   * flags those worker_done rows `replayed` instead of hiding them.
   */
  released: Set<string>;
  /** `<dispatch>:<kind>` attention entries this session already reported (once each). */
  attentionReported: Set<string>;
  /** request_id → the terminal a pre-warmed start created (join/replay reuse it). */
  startTerminals: Map<string, string>;
  /** dispatch_id → the terminal SENTINAL created for it (closed after release). */
  createdTerminals: Map<string, string>;
  /** request_id → the request id of its plain start after a skipped `retry_of`. */
  startSkips: Map<string, string>;
}

export function createOrcaToolState(): OrcaToolState {
  return {
    inflightStarts: new Map(),
    finishedStarts: new Map(),
    verdicts: new Map(),
    deliveries: new Map(),
    released: new Set(),
    attentionReported: new Set(),
    startTerminals: new Map(),
    createdTerminals: new Map(),
    startSkips: new Map(),
  };
}

export function orcaResponse(title: string, lines: string[], data: unknown) {
  return mcpText(
    [
      `## ${title}`,
      "",
      ...lines,
      "",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
  );
}

export function orcaFailure(
  title: string,
  error: OrcaError,
  extra: Record<string, unknown> = {},
  lines: string[] = [],
) {
  return orcaResponse(
    title,
    [`**Error** ${error.code}: ${error.message}`, ...lines],
    { ok: false, error, ...extra },
  );
}

export function clip(s: string, max = 2000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
