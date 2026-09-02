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
 * 2. `shutdown.signal` (default SIGTERM) to the **group**.
 * 3. Wait `graceMs`, polling liveness.
 * 4. SIGKILL to the group.
 * 5. Remove the pidfile.
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
  type OwnershipProbes,
} from "./ownership.js";
import type { StartTimeProbes } from "./proc-start.js";
import type { RuntimeConfig } from "./schema.js";

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
    // already refused above. So "owned" is exactly "leader verified".
    leaderVerified: verdict.kind === "owned",
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

  if (stillAlive) {
    try {
      signal(groupTarget, "SIGKILL");
      actions.push(
        `process group ${pgid} outlived the ${graceMs}ms grace period — escalated to SIGKILL`,
      );
    } catch (err) {
      warnings.push(
        `SIGKILL to process group ${pgid} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const removal = removePidfile(worktreePath, entry.pid);
  if (!removal.removed && removal.reason) warnings.push(removal.reason);

  return { ok: true, stopped: true, pid: entry.pid, pgid, actions, warnings };
}

/** Liveness of the leader, or of the witnessing member when the leader is dead. */
function safeAlive(
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
