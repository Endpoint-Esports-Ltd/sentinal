/**
 * Stall detection for supervised Orca workers (D7, spike S4).
 *
 * ⛔ Orca's safety floor: only POSITIVE evidence that the agent stopped may
 * authorize `worker-stop`. `unverifiable` or missing liveness is absence and
 * never yields a stall, whatever the transcript says. Positive evidence here:
 *   - `exited` fleet liveness (`worker-list`'s `projection.liveness`);
 *   - a live agent whose final transcript turn is an assistant turn carrying an
 *     auth failure (the spike's `401 … Please run /login`);
 *   - a live agent whose final assistant turn ended more than `maxIdleMs` ago
 *     without a `worker_done`;
 *   - with no transcript (OpenCode: terminal fallback), a terminal tail showing
 *     an auth failure, or the agent's empty home screen with the dispatch id
 *     never echoed, no heartbeat, and a dispatch older than `neverStartedMs`
 *     (`never-started`, issue #12 — the brief was dropped).
 */

import { runOrca, type OrcaError, type OrcaRunner } from "./cli.js";
import {
  AUTH_PATTERNS,
  authErrorInTail,
  mentionsDispatch,
  redactCapabilities,
  showsHomeScreen,
  terminalTail,
} from "./stall-terminal.js";
import type {
  OrcaTranscriptMessage,
  OrcaWorkerListResult,
  OrcaWorkerListRow,
  OrcaWorkerProjection,
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

export const DEFAULT_MAX_IDLE_MS = 10 * 60_000;
/** A home screen older than this, with no heartbeat, never got its brief. */
export const DEFAULT_NEVER_STARTED_MS = 180_000;
const READ_LIMIT = 20;

export type StallReason =
  "exited" | "auth-error" | "idle-no-report" | "never-started";

export interface StallVerdict {
  dispatchId: string | null;
  /** The Task, when the `worker-list` row names it (for a `retry_of` start). */
  taskId?: string;
  stalled: boolean;
  reason: StallReason | null;
  /** Human-readable facts behind the verdict (also why it is NOT a stall). */
  evidence: string;
}

export interface StallInput {
  workerListRow: OrcaWorkerListRow | null | undefined;
  transcript: OrcaWorkerReadResult | null | undefined;
  now: number;
  maxIdleMs?: number;
  /** The dispatch already reported `worker_done` — never a stall. */
  workerDoneSent?: boolean;
  /** `worker-show` for a home-screen suspect; absent → no `never-started`. */
  show?: OrcaWorkerShowResult | null;
  neverStartedMs?: number;
}

function projectionOf(
  row: OrcaWorkerListRow | null | undefined,
  read: OrcaWorkerReadResult | null | undefined,
): OrcaWorkerProjection | undefined {
  if (row?.projection) return row.projection;
  const p = read?.projection;
  return typeof p === "object" && p !== null
    ? (p as OrcaWorkerProjection)
    : undefined;
}

function textOf(m: OrcaTranscriptMessage): string {
  return (m.blocks ?? [])
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

function finalMessage(
  read: OrcaWorkerReadResult | null | undefined,
): OrcaTranscriptMessage | undefined {
  const msgs = read?.transcript?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined;
  return [...msgs]
    .filter((m) => typeof m?.timestamp === "number")
    .sort((a, b) => a.timestamp - b.timestamp)
    .at(-1);
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

/**
 * Orca prints `dispatchedAt` as "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
 * Returns epoch ms, or `null` when missing or unparsable (absence).
 */
export function parseDispatchedAt(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  let s = v.trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

type Verdict = (reason: StallReason | null, evidence: string) => StallVerdict;

/** The terminal-tail path: auth error, else never-started, else why not. */
function tailVerdict(
  tail: string[],
  dispatchId: string | null,
  input: StallInput,
  verdict: Verdict,
): StallVerdict {
  const auth = authErrorInTail(tail);
  if (auth) {
    return verdict(
      "auth-error",
      `terminal tail shows an auth failure: "${auth}"`,
    );
  }
  if (!showsHomeScreen(tail)) {
    return verdict(null, "live; terminal tail shows no home screen");
  }
  if (!dispatchId) {
    return verdict(null, "live; home screen visible, dispatch id unknown");
  }
  if (mentionsDispatch(tail, dispatchId)) {
    return verdict(null, "live; the dispatch id is in the terminal tail");
  }
  const d = input.show?.dispatch;
  if (!d)
    return verdict(null, "live; home screen visible, worker-show unavailable");
  if (d.lastHeartbeatAt != null) {
    return verdict(
      null,
      "live; home screen visible but a heartbeat was recorded",
    );
  }
  const at = parseDispatchedAt(d.dispatchedAt);
  if (at === null) {
    return verdict(null, "live; home screen visible, dispatchedAt unknown");
  }
  const age = input.now - at;
  const limit = input.neverStartedMs ?? DEFAULT_NEVER_STARTED_MS;
  const secs = `${Math.round(age / 1000)} s`;
  if (age > limit) {
    return verdict(
      "never-started",
      `dispatched ${secs} ago (> ${Math.round(limit / 1000)} s), no heartbeat, home screen visible, dispatch id never shown`,
    );
  }
  return verdict(
    null,
    `live; home screen visible but dispatched only ${secs} ago`,
  );
}

/** Pure verdict for one dispatch. Never throws. */
export function stallVerdict(input: StallInput): StallVerdict {
  const row = input.workerListRow;
  const read = input.transcript;
  const dispatchId =
    row?.dispatchId ??
    (typeof read?.dispatchId === "string" ? read.dispatchId : null);
  const verdict: Verdict = (reason, evidence) => ({
    dispatchId,
    ...(typeof row?.taskId === "string" ? { taskId: row.taskId } : {}),
    stalled: reason !== null,
    reason,
    evidence: redactCapabilities(evidence),
  });

  if (input.workerDoneSent) {
    return verdict(null, "worker_done already reported");
  }
  const liveness = projectionOf(row, read)?.liveness;
  const live = liveness?.verdict;
  if (live === "exited") {
    return verdict(
      "exited",
      `liveness exited${liveness?.reason ? ` (${liveness.reason})` : ""}`,
    );
  }
  if (live !== "live") {
    return verdict(
      null,
      `liveness ${live ?? "missing"}: absence never authorizes a stop`,
    );
  }

  const last = finalMessage(read);
  if (!last) {
    const tail = terminalTail(read);
    return tail
      ? tailVerdict(tail, dispatchId, input, verdict)
      : verdict(null, "live; no transcript turn to judge");
  }
  if (last.role !== "assistant") {
    return verdict(null, "live; the final turn is not an assistant turn");
  }
  const text = textOf(last);
  if (AUTH_PATTERNS.some((p) => p.test(text))) {
    return verdict(
      "auth-error",
      `final assistant turn is an auth failure: "${clip(text)}"`,
    );
  }
  const maxIdle = input.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const idle = input.now - last.timestamp;
  if (idle > maxIdle) {
    return verdict(
      "idle-no-report",
      `final assistant turn ended ${Math.round(idle / 1000)} s ago (> ${Math.round(maxIdle / 1000)} s) without worker_done`,
    );
  }
  return verdict(
    null,
    `live; last assistant turn ${Math.round(idle / 1000)} s ago`,
  );
}

/**
 * Is this row a dispatch that has not settled? Prefers the projection's
 * `outcome` (`in_progress`), else the row's worker/dispatch state.
 */
export function isActiveRow(row: OrcaWorkerListRow): boolean {
  const outcome = row.projection?.outcome;
  if (typeof outcome === "string") return outcome === "in_progress";
  const settled =
    /^(completed|succeeded|failed|stopped|abandoned|released|cancelled)$/;
  const states = [row.workerState, row.dispatchStatus].filter(
    (s): s is string => typeof s === "string",
  );
  return states.length > 0 && !states.some((s) => settled.test(s));
}

/** A dispatch whose terminal Orca reports as reclaimable (release it). */
export interface ReclaimableTerminal {
  dispatchId: string;
  taskId?: string;
  terminal?: string;
}

export type CollectStallsResult =
  | {
      ok: true;
      stalls: StallVerdict[];
      verdicts: StallVerdict[];
      reclaimable: ReclaimableTerminal[];
    }
  | { ok: false; error: OrcaError };

export interface CollectStallsOptions {
  runId: string;
  runner?: OrcaRunner;
  now?: number;
  maxIdleMs?: number;
  neverStartedMs?: number;
  /** Dispatches whose `worker_done` is in hand — skipped. */
  settledDispatchIds?: string[];
  /**
   * Shared deadline for ALL calls (list + reads), so one MCP tool call stays
   * under its ~60 s request timeout. Rows not read before it runs out are
   * skipped (absence — never a stall). Default 10 s.
   */
  budgetMs?: number;
  /** Monotonic clock for the budget (tests). */
  clock?: () => number;
}

const DEFAULT_STALL_BUDGET_MS = 10_000;
const MIN_CALL_MS = 1_000;

/**
 * Verdicts for every still-active dispatch of a Run: `worker-list --run`, then
 * `worker-read --source auto --limit 20` per active row. A failed read is
 * absence: only `exited` liveness can still make that row a stall. A read
 * whose tail shows the home screen without the dispatch id is confirmed with
 * `worker-show` (failure = absence). `reclaimable` comes from the same list,
 * settled rows included.
 */
export async function collectStalls(
  opts: CollectStallsOptions,
): Promise<CollectStallsResult> {
  const clock = opts.clock ?? (() => performance.now());
  const deadline = clock() + (opts.budgetMs ?? DEFAULT_STALL_BUDGET_MS);
  const left = () => deadline - clock();
  const list = await runOrca<OrcaWorkerListResult>(
    ["orchestration", "worker-list", "--run", opts.runId],
    { runner: opts.runner, timeoutMs: Math.max(left(), MIN_CALL_MS) },
  );
  if (!list.ok) return { ok: false, error: list.error };
  const settled = new Set(opts.settledDispatchIds ?? []);
  const all = (
    Array.isArray(list.result?.workers) ? list.result.workers : []
  ).filter((r) => typeof r?.dispatchId === "string");
  const reclaimable = all
    .filter((r) => r.terminalState === "reclaimable")
    .map(reclaimableOf);
  const rows = all.filter((r) => !settled.has(r.dispatchId) && isActiveRow(r));
  const now = opts.now ?? Date.now();

  const verdicts: StallVerdict[] = [];
  for (const row of rows) {
    if (left() < MIN_CALL_MS) break;
    const read = await runOrca<OrcaWorkerReadResult>(
      [
        "orchestration",
        "worker-read",
        "--dispatch",
        row.dispatchId,
        "--source",
        "auto",
        "--limit",
        String(READ_LIMIT),
      ],
      { runner: opts.runner, timeoutMs: left() },
    );
    const transcript = read.ok ? read.result : null;
    const tail = terminalTail(transcript);
    let show: OrcaWorkerShowResult | null = null;
    if (
      tail &&
      showsHomeScreen(tail) &&
      !mentionsDispatch(tail, row.dispatchId) &&
      left() >= MIN_CALL_MS
    ) {
      const s = await runOrca<OrcaWorkerShowResult>(
        ["orchestration", "worker-show", "--dispatch", row.dispatchId],
        { runner: opts.runner, timeoutMs: left() },
      );
      show = s.ok ? s.result : null;
    }
    verdicts.push(
      stallVerdict({
        workerListRow: row,
        transcript,
        show,
        now,
        maxIdleMs: opts.maxIdleMs,
        neverStartedMs: opts.neverStartedMs,
      }),
    );
  }
  return {
    ok: true,
    stalls: verdicts.filter((v) => v.stalled),
    verdicts,
    reclaimable,
  };
}

function reclaimableOf(r: OrcaWorkerListRow): ReclaimableTerminal {
  const out: ReclaimableTerminal = { dispatchId: r.dispatchId };
  if (typeof r.taskId === "string") out.taskId = r.taskId;
  if (typeof r.agentTerminalHandle === "string") {
    out.terminal = r.agentTerminalHandle;
  }
  return out;
}
