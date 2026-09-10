/**
 * Readiness polling — "we started something" is not "it is up".
 *
 * ## The rule the schema already enforces, and why
 *
 * `up` **requires** `readiness` (`schema.ts:255-266`). Starting a stack with no
 * way to know it started means the run proceeds against something that is not
 * ready and then fails somewhere unrelated — which is how a verification run
 * ends up being "debugged" by improvising ports and `pkill`.
 *
 * ## The asymmetry that carries this module
 *
 * | Leader exit | Meaning                                   | Action          |
 * | ----------- | ----------------------------------------- | --------------- |
 * | non-zero    | it crashed                                | **fail fast**   |
 * | zero        | a **detaching starter** did its job       | **keep polling** |
 *
 * `docker compose up -d`, `pm2 start` and every backgrounding wrapper exit 0 by
 * design; the stack comes up afterwards. Treating that as failure would break
 * the exact configuration the master plan names as the right answer. Treating a
 * crash as "still starting" would burn the full 60s budget and bury the error.
 *
 * A **final probe after the leader dies** mirrors `waitForDashboardHealthy`
 * (`src/dashboard/lifecycle.ts:283-296`): a starter can exit non-zero
 * *because* the service was already running.
 *
 * v1 supports `http` and `exec` only. `exec` subsumes the `tcp` and `log`
 * probes that were cut (`nc -z host port`, `grep -q … <logfile>`).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** The post-parse shape of `RuntimeConfig["readiness"]` (`schema.ts:177-205`). */
export interface ReadinessProbeSpec {
  type: "http" | "exec";
  target: string;
  /** `http` only. Defaults to "any 2xx-3xx". */
  expectStatus?: number[];
  startupTimeoutMs: number;
  pollIntervalMs: number;
}

export interface AwaitReadinessOptions {
  probe: ReadinessProbeSpec;
  /** Working directory for an `exec` probe. */
  cwd?: string;
  /**
   * The spawned leader's exit code, or `null` while it is still running.
   * Omit when the caller does not hold a handle — polling then relies purely
   * on the budget.
   */
  leaderExitCode?: () => number | null;
  /** Injectable probes. Production uses `fetch` and `sh -c`. */
  httpProbe?: (target: string) => Promise<number | null>;
  execProbe?: (target: string, cwd?: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReadinessResult {
  ready: boolean;
  /** How many times the probe was actually run. */
  attempts: number;
  elapsedMs: number;
  /** Set when the leader exited before readiness was reached. */
  leaderExitCode?: number;
  /** True when a ZERO-exit leader was treated as a detaching starter. */
  detachingStarter?: boolean;
  /** Human/LLM-facing. Present exactly when `ready` is false. */
  reason?: string;
}

// ─── Probes ─────────────────────────────────────────────────────────────────

/**
 * HTTP status, or `null` when the connection itself failed.
 *
 * ⛔ A connection failure is NOT an error here — it is the expected answer for
 * the first several seconds of any boot. Distinguishing it from a status keeps
 * the caller from treating "not yet" as "broken".
 */
export async function probeHttp(target: string): Promise<number | null> {
  try {
    const res = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return null;
  }
}

/** Exit code of `target` run through `sh`. Non-zero (or a throw) is "not yet". */
export async function probeExec(target: string, cwd?: string): Promise<number> {
  try {
    const proc = Bun.spawn(["sh", "-c", target], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return await proc.exited;
  } catch {
    return 1;
  }
}

/** Default acceptance: any 2xx or 3xx, unless `expectStatus` says otherwise. */
function statusAccepted(status: number, expectStatus?: number[]): boolean {
  if (expectStatus && expectStatus.length > 0) {
    return expectStatus.includes(status);
  }
  return status >= 200 && status < 400;
}

// ─── Poll ───────────────────────────────────────────────────────────────────

/**
 * Poll `probe.target` until it passes, the leader crashes, or the budget runs
 * out.
 *
 * ⛔ Never throws. A probe that throws is "not ready yet", not a crash of the
 * runner — the caller needs a structured result so it can run the compensating
 * `down` and attach a log tail.
 */
export async function awaitReadiness(
  opts: AwaitReadinessOptions,
): Promise<ReadinessResult> {
  const { probe } = opts;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const http = opts.httpProbe ?? probeHttp;
  const exec = opts.execProbe ?? probeExec;

  const started = now();
  const deadline = started + probe.startupTimeoutMs;
  let attempts = 0;
  let detachingStarter = false;

  const runProbe = async (): Promise<boolean> => {
    attempts++;
    try {
      if (probe.type === "exec") {
        return (await exec(probe.target, opts.cwd)) === 0;
      }
      const status = await http(probe.target);
      return status !== null && statusAccepted(status, probe.expectStatus);
    } catch {
      // A probe that throws is indistinguishable from one that failed. Both
      // mean "not yet".
      return false;
    }
  };

  const done = (extra: Partial<ReadinessResult>): ReadinessResult => ({
    ready: false,
    attempts,
    elapsedMs: now() - started,
    ...(detachingStarter ? { detachingStarter } : {}),
    ...extra,
  });

  // `do…while` rather than `while`: probe at least once even when the budget is
  // already spent, so a caller with an absurd timeout still gets an answer
  // rather than an unexplained failure.
  for (;;) {
    if (await runProbe()) return done({ ready: true, reason: undefined });

    const code = opts.leaderExitCode?.() ?? null;
    if (code !== null) {
      if (code !== 0) {
        // ⛔ Fail fast — but one FINAL probe first. A starter can exit non-zero
        // *because* the service was already up (dashboard/lifecycle.ts:283-296).
        if (await runProbe()) return done({ ready: true, reason: undefined });
        return done({
          leaderExitCode: code,
          reason:
            `the \`up\` command exited with code ${code} before ${probe.type} probe ` +
            `\`${probe.target}\` passed. It failed to start; the readiness budget was NOT ` +
            `waited out. See the runtime log for what it printed.`,
        });
      }
      // ⛔ ZERO exit means a DETACHING starter (`docker compose up -d`,
      // `pm2 start`, any backgrounding script). Keep polling — the stack comes
      // up after the command returns. This is the flagship case.
      detachingStarter = true;
    }

    if (now() >= deadline) break;
    await sleep(probe.pollIntervalMs);
  }

  return done({
    reason:
      `timed out after ${probe.startupTimeoutMs}ms waiting for ${probe.type} probe ` +
      `\`${probe.target}\` (${attempts} attempts)` +
      (detachingStarter
        ? `. The \`up\` command exited 0, so it was treated as a detaching starter and ` +
          `polling continued — but nothing ever answered the probe.`
        : `.`),
  });
}
