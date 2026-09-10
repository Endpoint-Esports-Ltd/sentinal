/**
 * Teardown — the correct alternative to `pkill -f`.
 *
 * ## The one rule
 *
 * **Never signal a PID or PGID without ownership verification, and REFUSE when
 * verification is impossible.** `src/runtime/ownership.ts` is the gate; this
 * module is the only thing in the codebase that sends a signal to a process
 * group, and it asks that gate first, every time.
 *
 * The dangerous case is a **dead leader**. Leader-PID verification is then
 * structurally impossible, and PGIDs are drawn from the same wrapping space as
 * PIDs — so a dead leader's recorded pgid can already belong to an unrelated
 * group. The rule there is: enumerate live members, require **at least one**
 * that provably references this worktree, and refuse otherwise.
 *
 * ## Order of operations (D12)
 *
 * 1. `down` if declared, bounded by `graceMs`. For a **detached** runtime this
 *    is the *real* mechanism: the spawned leader has already exited, so the
 *    pgid owns nothing and `kill -- -$PGID` would silently succeed while the
 *    stack kept running. The schema already enforces `detached ⇒ down`.
 * 2. **Re-verify ownership** (M4a, `teardown-verify.ts`) — the pre-`down`
 *    verdict is stale across the `down` window; a flipped verdict refuses.
 * 3. `shutdown.signal` (default SIGTERM) to the **group**.
 * 4. Wait `graceMs`, polling liveness.
 * 5. SIGKILL to the group, then **confirm the group actually died** (M4b) —
 *    a failed or ineffective SIGKILL keeps the pidfile and reports failure.
 * 6. Remove the pidfile.
 *
 * ⛔ **Idempotent, and a fast no-op when no pidfile exists.** `abandon` calls
 * this on every worktree, including ones that never started a runtime; paying
 * the grace period there would make the normal end-of-spec exit feel broken
 * (Pre-Mortem #2).
 *
 * ⛔ **A reused stack is never torn down** — that decision belongs to the
 * caller (the `runtime_up` preflight), which simply does not call this.
 */

import { openSync } from "node:fs";
import { loadRuntimeConfig } from "./loader.js";
import { inspectPidfile, removePidfile } from "./pidfile.js";
import { runtimeLogPath } from "./spawn.js";
import {
  maySignalGroup,
  isProcessAlive,
  type GroupProbes,
} from "./ownership.js";
import {
  reverifyAfterDown,
  confirmGroupDead,
  safeAlive,
} from "./teardown-verify.js";
import type { StartTimeProbes } from "./proc-start.js";
import type { RuntimeConfig } from "./schema.js";

// The post-run liveness surface lives with the other verification helpers.
export { assertStillAlive, type AliveVerdict } from "./teardown-verify.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShellResult {
  exitCode: number;
  timedOut: boolean;
}

/** Everything injectable, so the interesting cases can be staged on demand. */
export interface TeardownDeps {
  /** Structurally a `LoadedRuntimeConfig`; only `config` is read. */
  loadConfig?: (worktreePath: string) => { config: RuntimeConfig | null };
  probes?: GroupProbes & StartTimeProbes;
  /** `target` is NEGATIVE for a process group. */
  signalFn?: (target: number, signal: NodeJS.Signals) => void;
  runShell?: (
    cmd: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<ShellResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface StopResult {
  /** False means **nothing was signalled and the runtime may still be up**. */
  ok: boolean;
  /** True when this call actually tore something down. */
  stopped: boolean;
  /** What was done, in order — for the human reading the tool output. */
  actions: string[];
  /** Non-fatal problems (e.g. a failing `down`). */
  warnings: string[];
  /** Present exactly when `ok` is false. */
  reason?: string;
  pid?: number;
  pgid?: number | null;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Run `cmd` through `sh`, appending output to the runtime log and killing it
 * at `timeoutMs`.
 *
 * The log matters: a `down` that hangs or fails is the thing an agent needs to
 * see, and a `down` whose output went nowhere is how a half-torn-down stack
 * becomes a mystery.
 */
async function defaultRunShell(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
  let fd: number | undefined;
  try {
    fd = openSync(runtimeLogPath(cwd), "a");
  } catch {
    fd = undefined;
  }

  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd,
      stdin: "ignore",
      stdout: fd ?? "ignore",
      stderr: fd ?? "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { exitCode, timedOut };
  } catch {
    return { exitCode: 1, timedOut: false };
  }
}

const defaultSignal = (target: number, signal: NodeJS.Signals): void => {
  process.kill(target, signal);
};

// ─── Stop ───────────────────────────────────────────────────────────────────

/**
 * Terminate the process group recorded in `worktreePath`'s pidfile — and
 * nothing else.
 *
 * ⛔ Never throws. Callers include `abandon` and `squashMerge`, whose failure
 * modes must be an actionable message rather than an exception thrown out of a
 * directory-removal path.
 */
export async function stopOwnedGroup(
  worktreePath: string,
  deps: TeardownDeps = {},
): Promise<StopResult> {
  const probes = deps.probes ?? {};
  const signal = deps.signalFn ?? defaultSignal;
  const runShell = deps.runShell ?? defaultRunShell;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const platform = deps.platform ?? process.platform;
  const alive = probes.isAlive ?? isProcessAlive;

  const actions: string[] = [];
  const warnings: string[] = [];

  const verdict = inspectPidfile(worktreePath, probes);

  // ── Fast no-op: nothing was ever started here ────────────────────────────
  if (verdict.kind === "absent") {
    return {
      ok: true,
      stopped: false,
      actions: [
        "No .sentinal/runtime.pid — Sentinal started nothing in this worktree, so there is nothing to stop.",
      ],
      warnings,
    };
  }

  if (verdict.kind === "unreadable" || verdict.kind === "foreign") {
    return {
      ok: false,
      stopped: false,
      actions,
      warnings,
      reason:
        verdict.reason +
        " REFUSING to signal anything. Confirm by hand what is running, then delete " +
        ".sentinal/runtime.pid yourself.",
    };
  }

  const entry = verdict.entry;
  const config = (deps.loadConfig ?? loadRuntimeConfig)(worktreePath).config;
  const graceMs = config?.shutdown.graceMs ?? 10000;
  const stopSignal = (config?.shutdown.signal ?? "SIGTERM") as NodeJS.Signals;

  // ── Step 1: the declared `down` ──────────────────────────────────────────
  let ranDown = false;
  if (config?.down) {
    const r = await runShell(config.down, worktreePath, graceMs).catch(
      () => ({ exitCode: 1, timedOut: false }) as ShellResult,
    );
    ranDown = true;
    actions.push(`ran \`down\`: ${config.down} (exit ${r.exitCode})`);
    if (r.timedOut) {
      warnings.push(
        `\`down\` (${config.down}) was killed after ${graceMs}ms. Signal escalation continues, ` +
          `but anything it manages outside this process group may still be running.`,
      );
    } else if (r.exitCode !== 0) {
      warnings.push(
        `\`down\` (${config.down}) exited ${r.exitCode}. Signal escalation continues anyway — a ` +
          `partial teardown is not a teardown — but check the runtime log.`,
      );
    }
  }

  // ── Step 1b: re-verify AFTER `down` (M4a) ────────────────────────────────
  // The verdict above is stale by construction once `down` has run: `down` is
  // bounded only by graceMs, long enough for the leader to die and its PID to
  // be recycled. A flipped verdict must prevent the signal.
  let leaderVerified = verdict.kind === "owned";
  if (ranDown) {
    const re = reverifyAfterDown(worktreePath, entry, probes);
    if (re.kind === "refuse") {
      return {
        ok: false,
        stopped: false,
        pid: entry.pid,
        pgid: entry.pgid,
        actions,
        warnings,
        reason: re.reason,
      };
    }
    leaderVerified = re.leaderVerified;
  }

  // ── Step 2: is there a group to signal at all? ───────────────────────────
  if (entry.pgid === null) {
    // No process-group guarantee (Windows). `down` is the only mechanism.
    if (ranDown) {
      removePidfile(worktreePath, entry.pid);
      return {
        ok: true,
        stopped: true,
        pid: entry.pid,
        pgid: null,
        actions: [
          ...actions,
          `no process group is recorded for this platform (${platform}), so teardown reduced to the ` +
            `declared \`down\`. The guarantee is "we ran the declared \`down\`", NOT "we own the PIDs".`,
        ],
        warnings,
      };
    }
    // ⛔ Never report success here. There is neither a group to signal nor a
    // command to run, and the process is still up.
    return {
      ok: false,
      stopped: false,
      pid: entry.pid,
      pgid: null,
      actions,
      warnings,
      reason:
        `UNSUPPORTED CONFIGURATION: pid ${entry.pid} is running, this platform (${platform}) records ` +
        `no process group for it, and .sentinal/runtime.json declares no \`down\`. Sentinal has no ` +
        `way to stop it and will NOT pretend otherwise. Remedy: add a \`down\` command to the ` +
        `runtime contract, then stop pid ${entry.pid} by hand this once.`,
    };
  }

  const pgid = entry.pgid;

  // ── Step 3: prove we may signal this group ───────────────────────────────
  const gate = maySignalGroup({
    pgid,
    leaderPid: entry.pid,
    // `inspectPidfile` returns "owned" only for a process it has proven alive
    // AND ours; anything it could not establish comes back "foreign", which was
    // already refused above. So "owned" is exactly "leader verified" — from the
    // POST-`down` re-verification when a `down` ran (M4a).
    leaderVerified,
    worktreePath,
    probes,
  });
  if (gate.kind === "gone") {
    removePidfile(worktreePath, entry.pid);
    return {
      ok: true,
      stopped: ranDown,
      pid: entry.pid,
      pgid,
      actions: [
        ...actions,
        `process group ${pgid} has no live members — the runtime is already stopped. Removed the ` +
          `stale ownership record.`,
      ],
      warnings,
    };
  }
  if (gate.kind === "refuse") {
    return {
      ok: false,
      stopped: ranDown,
      pid: entry.pid,
      pgid,
      actions,
      warnings,
      reason: gate.reason,
    };
  }

  // ── Step 4: signal → grace → SIGKILL ─────────────────────────────────────
  const groupTarget = -pgid;
  try {
    signal(groupTarget, stopSignal);
    actions.push(`sent ${stopSignal} to process group ${pgid}`);
  } catch (err) {
    warnings.push(
      `${stopSignal} to process group ${pgid} failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const deadline = now() + graceMs;
  let stillAlive = safeAlive(alive, entry.pid, gate.witness);
  while (stillAlive && now() < deadline) {
    await sleep(Math.min(50, Math.max(1, Math.floor(graceMs / 4))));
    stillAlive = safeAlive(alive, entry.pid, gate.witness);
  }

  // ── Step 5: SIGKILL, then CONFIRM the outcome (M4b) ──────────────────────
  // ⛔ A failed SIGKILL is a FAILURE, not a warning. Converting the exception
  // to a warning and deleting the pidfile anyway (the old shape) orphans a
  // LIVE group — reachable via EPERM (e.g. a root-owned process cwd'd here).
  if (stillAlive) {
    let killFailure: string | null = null;
    try {
      signal(groupTarget, "SIGKILL");
      actions.push(
        `process group ${pgid} outlived the ${graceMs}ms grace period — escalated to SIGKILL`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") {
        // ESRCH means the group vanished between the poll and the kill — a
        // success. Anything else means the signal was NOT delivered.
        killFailure =
          `SIGKILL to process group ${pgid} FAILED: ` +
          `${err instanceof Error ? err.message : String(err)}.`;
      }
    }
    const dead = await confirmGroupDead({
      alive,
      leaderPid: entry.pid,
      witness: gate.witness,
      sleep,
    });
    if (killFailure !== null || !dead) {
      return {
        ok: false,
        stopped: false,
        pid: entry.pid,
        pgid,
        actions,
        warnings,
        reason:
          (killFailure ??
            `process group ${pgid} is STILL ALIVE after SIGKILL.`) +
          ` The runtime may still be running, so the ownership record is KEPT — deleting it ` +
          `would leave an orphan nothing can find again. Confirm by hand with ` +
          `\`ps -A -o pid=,pgid=,command= | awk '$2 == ${pgid}'\`, stop what you recognise, ` +
          `then delete .sentinal/runtime.pid.`,
      };
    }
  }

  const removal = removePidfile(worktreePath, entry.pid);
  if (!removal.removed && removal.reason) warnings.push(removal.reason);

  return { ok: true, stopped: true, pid: entry.pid, pgid, actions, warnings };
}
