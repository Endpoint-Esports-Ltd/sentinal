/**
 * Process start-time verification — the H5 tiebreaker behind every `owned`
 * verdict.
 *
 * ## Why command line and cwd are not enough
 *
 * `processBelongsToWorktree` proves a live pid references this worktree by
 * command line or working directory. In wave execution that proof is forgeable
 * BY ACCIDENT: the agent session, the user's editor and their shell all have
 * the worktree as their cwd, so a recycled leader PID landing on any of them
 * passes as `owned` — and preflight/teardown would then SIGTERM/SIGKILL the
 * user's process group, the pkill-class incident this module exists to
 * prevent.
 *
 * The recorded `startedAt` is the tiebreaker. The pidfile is written
 * IMMEDIATELY after spawn, BEFORE readiness polling (`lifecycle.ts` — the
 * "⛔ IMMEDIATELY" comment), so it is within spawn latency (~ms) of the true
 * process start. A live process wearing the recorded PID but started at a
 * different time is NOT the leader Sentinal started.
 *
 * ## Comparison: `ps -o etime=`, never `lstart`
 *
 * ⚠️ `etimes` (bare seconds) is procps-ONLY — macOS/BSD `ps(1)` rejects the
 * keyword outright ("keyword not found"). The portable field is POSIX `etime`,
 * whose `[[dd-]hh:]mm:ss` shape is a numeric, locale-independent DURATION on
 * both macOS and procps/Linux (CI is ubuntu) and is parsed by a strict regex.
 * `lstart` is a locale/format-dependent date string — parsing it is exactly
 * the kind of guess this module's fail-closed doctrine forbids.
 *
 * ## Tolerance: ±{@link START_TIME_TOLERANCE_MS} (5s)
 *
 * The legitimate drift budget between record and observation:
 *   - `etime` reports WHOLE seconds (truncated), so the derived epoch start
 *     (`now − elapsed·1000`) can overstate the true start by up to 999ms;
 *   - the capture-side `Date.now()` runs a few ms after the spawn returns;
 *   - the compare-side `Date.now()` is sampled after `ps` computed its answer,
 *     adding up to another second of skew under load.
 * Worst case is therefore ~2s; 5s gives 2.5x headroom while staying orders of
 * magnitude below PID-reuse timescales — a recycled PID's true start differs
 * from the record by whole process lifetimes.
 *
 * ## Fail closed
 *
 * A `ps` that could not answer (missing, non-zero, unparsable) is `unknown`.
 * Callers treat that exactly like the module's existing `unreadable`/`foreign`
 * doctrine: refuse to signal, keep the pidfile. **Never kill on uncertainty.**
 */

export interface StartTimeProbes {
  /**
   * Epoch ms at which the live process `pid` started, or `null` when it
   * cannot be determined. Injectable for the same reason as
   * `OwnershipProbes`: PID reuse cannot be produced on demand.
   */
  startTimeOf?(pid: number): number | null;
}

export const START_TIME_TOLERANCE_MS = 5_000;

export type StartTimeVerdict =
  /** The live start time agrees with the record, within tolerance. */
  | { kind: "match" }
  /**
   * The record carries no usable `startedAt` (written before this check
   * existed, or defensively invalid). The comparison is SKIPPED — running
   * stacks must not be orphaned or refused by an upgrade — and callers
   * proceed exactly as they did before H5.
   */
  | { kind: "legacy" }
  /** The live process started at a different time. It is NOT our leader. */
  | { kind: "mismatch"; reason: string }
  /** `ps` could not answer. Refuse to signal; keep the pidfile. */
  | { kind: "unknown"; reason: string };

/** What one `ps -o etime= -p <pid>` invocation produced. */
export interface PsEtimeResult {
  exitCode: number;
  stdout: string;
}

function runPsEtime(pid: number): PsEtimeResult | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return { exitCode: r.exitCode, stdout: r.stdout?.toString() ?? "" };
  } catch {
    return null;
  }
}

/** Elapsed seconds from a POSIX `etime` duration, or `null` when malformed. */
function parseEtimeSeconds(out: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(out.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/**
 * The epoch ms at which `pid` started, derived as `now − elapsed·1000` — or
 * `null` when `ps` was unavailable, exited non-zero, or produced output that
 * is not a well-formed `etime` duration. `run` is a seam for staging exactly
 * those failures.
 */
export function realStartTimeOf(
  pid: number,
  run: (pid: number) => PsEtimeResult | null = runPsEtime,
): number | null {
  const r = run(pid);
  if (r === null || r.exitCode !== 0) return null;
  const elapsed = parseEtimeSeconds(r.stdout);
  if (elapsed === null) return null;
  return Date.now() - elapsed * 1000;
}

/**
 * Does the live process wearing `pid` plausibly have the recorded start time?
 *
 * ⛔ Only `match` and `legacy` may be read as "proceed as owned". `mismatch`
 * means the PID was recycled (route to the stale/dead-leader doctrine);
 * `unknown` means verification was impossible (refuse to signal, keep the
 * pidfile).
 */
export function verifyStartTime(
  pid: number,
  recordedStartedAt: number,
  probes: StartTimeProbes = {},
): StartTimeVerdict {
  if (!Number.isFinite(recordedStartedAt) || recordedStartedAt <= 0) {
    return { kind: "legacy" };
  }

  const probe = probes.startTimeOf ?? realStartTimeOf;
  let observed: number | null;
  try {
    observed = probe(pid);
  } catch (err) {
    return {
      kind: "unknown",
      reason: unknownReason(
        pid,
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
  if (observed === null || !Number.isFinite(observed)) {
    return {
      kind: "unknown",
      reason: unknownReason(
        pid,
        "`ps -o etime=` was unavailable, exited non-zero, or produced " +
          "output that could not be parsed",
      ),
    };
  }

  const driftMs = Math.abs(observed - recordedStartedAt);
  if (driftMs <= START_TIME_TOLERANCE_MS) return { kind: "match" };

  return {
    kind: "mismatch",
    reason:
      `pid ${pid} is alive, but it started around ` +
      `${new Date(observed).toISOString()} — not ${new Date(recordedStartedAt).toISOString()} ` +
      `as recorded at spawn (drift ~${Math.round(driftMs / 1000)}s, tolerance ` +
      `${START_TIME_TOLERANCE_MS / 1000}s). The PID has been RECYCLED onto a different ` +
      `process; the leader Sentinal started is gone. The live process will NOT be ` +
      `signalled on this record's account.`,
  };
}

function unknownReason(pid: number, why: string): string {
  return (
    `pid ${pid} is alive and references this worktree, but its start time could not be ` +
    `verified against the recorded startedAt: ${why}. Without that check a recycled PID ` +
    `cannot be ruled out, so REFUSING to treat the process as ours — it will not be ` +
    `signalled, and the ownership record is kept. Remedy: make \`ps -o etime= -p ${pid}\` ` +
    `work, confirm by hand what pid ${pid} is, then delete .sentinal/runtime.pid if it ` +
    `is not yours.`
  );
}
