/**
 * Agent liveness in Orca's documented precedence, and the never-started
 * evidence shared by stalls and attention entries
 * (docs/plans/2026-09-30-orca-unverifiable-never-started.md).
 *
 * Orca's guide (`--reference recovery-and-cleanup`): `worker-list`'s
 * `projection.liveness` is the fleet verdict. When it is `unverifiable` for a
 * reason that names a gap on this client (`missing_status`,
 * `capability_unsupported`), a `worker-show` verdict "is the better evidence
 * and outranks the row". `host_unavailable` is contact loss — excluded here.
 * "`unverifiable` from either command still authorizes nothing — only a
 * positive `live` or `exited` verdict does."
 *
 * ⛔ So an `absent` resolution never yields a stall. A dropped brief under
 * `unverifiable` liveness (Orca 1.4.209, issue #12) is reported as an
 * ATTENTION entry — no `evidence_id`, never a stop, abandon or retry. The
 * terminal's own PTY liveness may INFORM that entry; it authorizes nothing.
 */

import {
  mentionsDispatch,
  redactCapabilities,
  showsHomeScreen,
  terminalTail,
} from "./stall-terminal.js";
import type {
  OrcaWorkerListRow,
  OrcaWorkerProjection,
  OrcaWorkerReadResult,
  OrcaWorkerShowResult,
} from "./types.js";

/** A home screen older than this, with no heartbeat, never got its brief. */
export const DEFAULT_NEVER_STARTED_MS = 180_000;

/** Unverifiable reasons that name a client-side gap, not contact loss. */
export const GAP_REASONS: readonly string[] = [
  "missing_status",
  "capability_unsupported",
];

export interface ResolvedLiveness {
  verdict: "live" | "exited" | "absent";
  source: "list" | "worker-show" | null;
  /** The fleet reason (`missing_status`, `process gone`, …) when known. */
  reason?: string;
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

const positive = (v: unknown): "live" | "exited" | null =>
  v === "live" || v === "exited" ? v : null;

export function resolveLiveness(o: {
  row?: OrcaWorkerListRow | null;
  read?: OrcaWorkerReadResult | null;
  show?: OrcaWorkerShowResult | null;
}): ResolvedLiveness {
  const l = projectionOf(o.row, o.read)?.liveness;
  const reason = typeof l?.reason === "string" ? l.reason : undefined;
  const listed = positive(l?.verdict);
  if (listed) {
    return {
      verdict: listed,
      source: "list",
      ...(reason ? { reason } : {}),
    };
  }
  if (l?.verdict === "unverifiable" && reason && GAP_REASONS.includes(reason)) {
    const s = o.show?.projection?.liveness;
    const shown = positive(s?.verdict);
    if (shown) {
      return {
        verdict: shown,
        source: "worker-show",
        ...(typeof s?.reason === "string" ? { reason: s.reason } : {}),
      };
    }
  }
  return { verdict: "absent", source: null, ...(reason ? { reason } : {}) };
}

/**
 * Is the dispatch's OWN terminal positively live? Either the read's PTY status
 * on the dispatch's own handle (the fields recorded on 1.4.209), or
 * `worker-show`'s `observation` for the exact worker. PTY liveness only.
 */
export function ownTerminalLive(o: {
  read?: OrcaWorkerReadResult | null;
  show?: OrcaWorkerShowResult | null;
}): boolean {
  const obs = o.show?.observation;
  if (obs?.status === "live" && obs.exactWorker === true) return true;
  const handle = o.read?.terminal?.handle;
  if (o.read?.status?.liveness !== "live" || typeof handle !== "string") {
    return false;
  }
  return (
    handle === o.show?.dispatch?.assigneeHandle ||
    handle === o.show?.worker?.agentTerminalHandle
  );
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

export type NeverStartedEvidence =
  { ok: true; evidence: string } | { ok: false; why: string };

/** The never-started facts (home screen, no id, no heartbeat, age). Pure. */
export function neverStartedEvidence(o: {
  tail: readonly string[];
  dispatchId: string | null;
  show: OrcaWorkerShowResult | null | undefined;
  now: number;
  limitMs?: number;
}): NeverStartedEvidence {
  const no = (why: string): NeverStartedEvidence => ({ ok: false, why });
  if (!showsHomeScreen(o.tail)) return no("terminal tail shows no home screen");
  if (!o.dispatchId) return no("home screen visible, dispatch id unknown");
  if (mentionsDispatch(o.tail, o.dispatchId)) {
    return no("the dispatch id is in the terminal tail");
  }
  const d = o.show?.dispatch;
  if (!d) return no("home screen visible, worker-show unavailable");
  if (d.lastHeartbeatAt != null) {
    return no("home screen visible but a heartbeat was recorded");
  }
  const at = parseDispatchedAt(d.dispatchedAt);
  if (at === null) return no("home screen visible, dispatchedAt unknown");
  const age = o.now - at;
  const limit = o.limitMs ?? DEFAULT_NEVER_STARTED_MS;
  const secs = `${Math.round(age / 1000)} s`;
  if (age <= limit) {
    return no(`home screen visible but dispatched only ${secs} ago`);
  }
  return {
    ok: true,
    evidence: `dispatched ${secs} ago (> ${Math.round(limit / 1000)} s), no heartbeat, home screen visible, dispatch id never shown`,
  };
}

/** A condition to report to the user — NEVER a stall, never an evidence id. */
export interface AttentionEntry {
  kind: "never-started-unverifiable" | "orca-attention";
  dispatchId: string;
  taskId?: string;
  evidence?: string;
  categories?: string[];
  nextAction?: string[] | null;
}

/**
 * A brief that was probably dropped while Orca cannot verify the agent:
 * unverifiable for a client gap, the dispatch's own terminal live, and every
 * never-started fact. Reported to the user only (Orca forbids acting here).
 */
export function unverifiableAttention(o: {
  row: OrcaWorkerListRow;
  read: OrcaWorkerReadResult | null;
  show: OrcaWorkerShowResult | null;
  now: number;
  limitMs?: number;
}): AttentionEntry | null {
  const l = resolveLiveness(o);
  if (l.verdict !== "absent" || !l.reason || !GAP_REASONS.includes(l.reason)) {
    return null;
  }
  const tail = terminalTail(o.read);
  if (!tail || !ownTerminalLive(o)) return null;
  const e = neverStartedEvidence({
    tail,
    dispatchId: o.row.dispatchId,
    show: o.show,
    now: o.now,
    limitMs: o.limitMs,
  });
  if (!e.ok) return null;
  return {
    kind: "never-started-unverifiable",
    dispatchId: o.row.dispatchId,
    ...(typeof o.row.taskId === "string" ? { taskId: o.row.taskId } : {}),
    evidence: redactCapabilities(
      `Orca's agent liveness is unverifiable (${l.reason}); the worker's own terminal is live; ${e.evidence}`,
    ),
  };
}
