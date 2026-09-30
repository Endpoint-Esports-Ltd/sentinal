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
 *
 * Liveness follows Orca's precedence (`stall-liveness.ts`): for a client-gap
 * `unverifiable` row, `worker-show`'s positive verdict outranks it. A dropped
 * brief under still-unverifiable liveness is an ATTENTION entry, never a stall.
 */

import { runOrca, type OrcaError, type OrcaRunner } from "./cli.js";
import {
  GAP_REASONS,
  neverStartedEvidence,
  resolveLiveness,
  unverifiableAttention,
  type AttentionEntry,
} from "./stall-liveness.js";
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
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

export {
  DEFAULT_NEVER_STARTED_MS,
  parseDispatchedAt,
  type AttentionEntry,
} from "./stall-liveness.js";
export const DEFAULT_MAX_IDLE_MS = 10 * 60_000;
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
  const e = neverStartedEvidence({
    tail,
    dispatchId,
    show: input.show,
    now: input.now,
    limitMs: input.neverStartedMs,
  });
  return e.ok
    ? verdict("never-started", e.evidence)
    : verdict(null, `live; ${e.why}`);
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
  const l = resolveLiveness({ row, read, show: input.show });
  const via = l.source === "worker-show" ? " per worker-show" : "";
  if (l.verdict === "exited") {
    return verdict(
      "exited",
      `liveness exited${l.reason ? ` (${l.reason})` : ""}${via}`,
    );
  }
  if (l.verdict !== "live") {
    const raw = row?.projection?.liveness?.verdict ?? "missing";
    return verdict(
      null,
      `liveness ${raw}${l.reason ? ` (${l.reason})` : ""}: absence never authorizes a stop`,
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
      /** Report to the user — never stalls, never an evidence id. */
      attention: AttentionEntry[];
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
  const attention: AttentionEntry[] = [];
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
    const lv = row.projection?.liveness;
    const gap =
      lv?.verdict === "unverifiable" &&
      typeof lv.reason === "string" &&
      GAP_REASONS.includes(lv.reason);
    const suspect =
      !!tail &&
      showsHomeScreen(tail) &&
      !mentionsDispatch(tail, row.dispatchId);
    let show: OrcaWorkerShowResult | null = null;
    if ((suspect || gap) && left() >= MIN_CALL_MS) {
      const s = await runOrca<OrcaWorkerShowResult>(
        ["orchestration", "worker-show", "--dispatch", row.dispatchId],
        { runner: opts.runner, timeoutMs: left() },
      );
      show = s.ok ? s.result : null;
    }
    const v = stallVerdict({
      workerListRow: row,
      transcript,
      show,
      now,
      maxIdleMs: opts.maxIdleMs,
      neverStartedMs: opts.neverStartedMs,
    });
    verdicts.push(v);
    if (!v.stalled) {
      const a =
        unverifiableAttention({
          row,
          read: transcript,
          show,
          now,
          limitMs: opts.neverStartedMs,
        }) ?? orcaAttention(row);
      if (a) attention.push(a);
    }
  }
  return {
    ok: true,
    stalls: verdicts.filter((v) => v.stalled),
    verdicts,
    reclaimable,
    attention,
  };
}

/**
 * Orca flags the row `requiresAction` and no stall was proven. The bare
 * `["unverifiable"]` category is left out: on 1.4.209 every healthy OpenCode
 * worker carries it, and its actionable form is `never-started-unverifiable`.
 */
function orcaAttention(row: OrcaWorkerListRow): AttentionEntry | null {
  const at = row.projection?.attention;
  const cats = Array.isArray(at?.categories) ? at.categories : [];
  if (at?.requiresAction !== true) return null;
  if (cats.length === 1 && cats[0] === "unverifiable") return null;
  const argv = row.projection?.nextAction?.argv;
  return {
    kind: "orca-attention",
    dispatchId: row.dispatchId,
    ...(typeof row.taskId === "string" ? { taskId: row.taskId } : {}),
    categories: cats,
    nextAction: Array.isArray(argv) && argv.length ? argv : null,
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
