/**
 * Teardown's verification helpers — the checks that close the two TOCTOU
 * windows inside `stopOwnedGroup` (M4a / M4b), plus the post-run liveness
 * surface (`assertStillAlive`).
 *
 * Split out of `teardown.ts` for length, not for optionality: everything here
 * follows the same fail-closed doctrine — **never signal on a stale or
 * unknowable verdict, and never delete an ownership record while the group may
 * still be alive.**
 */

import { inspectPidfile, type RuntimePidfile } from "./pidfile.js";
import type { GroupProbes, OwnershipProbes } from "./ownership.js";
import type { StartTimeProbes } from "./proc-start.js";

// ─── Post-`down` re-verification (M4a) ──────────────────────────────────────

export type PostDownVerdict =
  /** Cleared to continue. `leaderVerified` feeds `maySignalGroup`. */
  | { kind: "proceed"; leaderVerified: boolean }
  /** The world changed while `down` ran. Nothing may be signalled. */
  | { kind: "refuse"; reason: string };

/**
 * Re-derive the ownership verdict AFTER the declared `down` has run.
 *
 * ⛔ The pre-`down` verdict is stale by construction: `down` is bounded only
 * by `graceMs`, which is long enough for the recorded leader to die and its
 * PID to be recycled — after which the original "owned" would short-circuit
 * `maySignalGroup` into signalling a stranger's group. `inspectPidfile` here
 * re-runs the full chain, including `proc-start.ts`'s start-time check (H5).
 *
 * A leader that DIED during `down` is the routine success shape (`down` doing
 * its job), so it proceeds — unverified, which forces `maySignalGroup` to
 * enumerate the group and either find it gone or demand a proven member.
 */
export function reverifyAfterDown(
  worktreePath: string,
  before: RuntimePidfile,
  probes: GroupProbes & StartTimeProbes = {},
): PostDownVerdict {
  const verdict = inspectPidfile(worktreePath, probes);

  switch (verdict.kind) {
    case "owned":
    case "stale": {
      if (verdict.entry.pid !== before.pid) {
        return {
          kind: "refuse",
          reason:
            `REFUSING to signal: while \`down\` ran, .sentinal/runtime.pid changed hands — it now ` +
            `records pid ${verdict.entry.pid}, not ${before.pid}. Another runtime_up claimed this ` +
            `worktree mid-teardown; signalling on the old record would hit the wrong group.`,
        };
      }
      return { kind: "proceed", leaderVerified: verdict.kind === "owned" };
    }

    case "absent":
      return {
        kind: "refuse",
        reason:
          `REFUSING to signal: .sentinal/runtime.pid DISAPPEARED while \`down\` ran, so there is ` +
          `nothing left to verify the recorded group (pgid ${before.pgid ?? "unknown"}) against. ` +
          `Signalling on the pre-\`down\` verdict is exactly the stale-verdict race this check ` +
          `exists to close. Confirm by hand whether anything from this worktree is still running.`,
      };

    default:
      // `foreign` / `unreadable`: the verdict FLIPPED during `down` — most
      // likely the leader died and its PID was recycled onto an unrelated
      // process, or the record was corrupted. Do not signal; keep the record.
      return {
        kind: "refuse",
        reason:
          `REFUSING to signal: ownership was re-verified after \`down\` completed and the verdict ` +
          `changed. ${verdict.reason} The pre-\`down\` verdict is not trusted across the ` +
          `\`down\` window (it can run for the full grace period), so nothing will be signalled ` +
          `and the ownership record is kept.`,
      };
  }
}

// ─── Post-SIGKILL confirmation (M4b) ────────────────────────────────────────

export interface ConfirmGroupDeadOptions {
  alive: (pid: number) => boolean;
  leaderPid: number;
  /** The group member that proved ownership when the leader is dead. */
  witness: number | null;
  sleep: (ms: number) => Promise<void>;
  /** Re-probe budget. SIGKILL is immediate but reaping can lag briefly. */
  attempts?: number;
  intervalMs?: number;
}

/**
 * Did the group actually die?
 *
 * ⛔ SIGKILL cannot be caught, but it CAN fail to be delivered (EPERM) and its
 * effect can lag (zombie reaping). Reporting success on the *attempt* rather
 * than the *outcome* is how a live group loses its only ownership record.
 * An unknowable liveness reads as ALIVE — never as dead.
 */
export async function confirmGroupDead(
  opts: ConfirmGroupDeadOptions,
): Promise<boolean> {
  const attempts = opts.attempts ?? 5;
  const intervalMs = opts.intervalMs ?? 40;
  for (let i = 0; i < attempts; i++) {
    if (!safeAlive(opts.alive, opts.leaderPid, opts.witness)) return true;
    await opts.sleep(intervalMs);
  }
  return !safeAlive(opts.alive, opts.leaderPid, opts.witness);
}

/** Liveness of the leader, or of the witnessing member when the leader is dead. */
export function safeAlive(
  alive: (pid: number) => boolean,
  leaderPid: number,
  witness: number | null,
): boolean {
  const check = (pid: number) => {
    try {
      return alive(pid);
    } catch {
      // Unknowable liveness must not be read as "dead" — that would skip the
      // SIGKILL escalation and leave the group running.
      return true;
    }
  };
  if (check(leaderPid)) return true;
  return witness !== null && check(witness);
}

// ─── Liveness re-check (D12) ────────────────────────────────────────────────

export interface AliveVerdict {
  alive: boolean;
  reason?: string;
}

/**
 * Is the runtime this worktree started **still** running?
 *
 * ⛔ "Tests green but the server died mid-run" is a **false pass**. Without an
 * exported surface for this the requirement stays unowned prose, so a caller
 * that finishes a test run must consult this before reporting success.
 *
 * **No pidfile is `alive: true`.** A project that never adopted the contract
 * must behave exactly as it did before the contract existed — reporting its
 * runs as failed because there is nothing to check would break the master
 * plan's headline backward-compatibility guarantee. The `reason` says which
 * case produced the verdict, so a caller that cares can tell them apart.
 */
export function assertStillAlive(
  worktreePath: string,
  probes: OwnershipProbes & StartTimeProbes = {},
): AliveVerdict {
  const verdict = inspectPidfile(worktreePath, probes);
  switch (verdict.kind) {
    case "absent":
      return {
        alive: true,
        reason:
          "no .sentinal/runtime.pid — Sentinal started nothing here, so there is nothing that could " +
          "have died mid-run.",
      };
    case "owned":
      return { alive: true };
    case "stale":
      return {
        alive: false,
        reason:
          `the runtime started for this worktree is GONE: ${verdict.reason} A run that finished ` +
          `green against a stack that died partway through is a FALSE PASS — treat it as a failure ` +
          `and re-run after \`runtime_up\`.`,
      };
    default:
      return { alive: false, reason: verdict.reason };
  }
}
