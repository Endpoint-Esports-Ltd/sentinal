/**
 * The exclusive `runtime_up` claim (M4c).
 *
 * ## The race this closes
 *
 * preflight → spawn → writePidfile was not exclusive: two concurrent
 * `runtime_up` calls could both pass preflight (both read "absent, port
 * free"), both spawn a detached group, and the LAST writer owned the pidfile.
 * The loser's group then had **no ownership record at all** — the exact orphan
 * D5's pidfile exists to prevent, and one that `runtime_stop` can never find.
 *
 * ## The design: claim → spawn → update
 *
 * The pidfile itself is the claim, written **before** spawn with
 * `writeFileSync(path, data, { flag: "wx" })` (`O_CREAT|O_EXCL` — atomic on
 * every filesystem this runs on). The claim carries a SENTINEL identity:
 * `pid` is the claiming orchestrator (this process), `pgid` is `null` (no
 * group exists yet) and `state` is `"claiming"`. After a successful spawn the
 * winner overwrites its own claim with the real record (`state: "starting"`);
 * on a spawn failure it releases the claim.
 *
 * `EEXIST` means someone else holds the worktree — a claim, a starting stack
 * or a ready one — and the loser re-runs preflight to find out which, spawning
 * nothing itself.
 *
 * ## Stale claims
 *
 * A claim whose claimer has DIED (crash between claim and spawn) is released
 * on the next preflight. A claim whose claimer is alive — or whose liveness
 * cannot be established — is held; releasing a live claim IS the race. The
 * window in which a crash can leave a spawned-but-unrecorded group (between
 * spawn and the update write) is the same sub-millisecond window the old
 * spawn-then-write code had for its entire startup, and the port-bound
 * preflight row still catches it for http contracts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { excludeFromGit } from "../worktree/git-exclude.js";
import {
  RUNTIME_LOG_RELATIVE_PATH,
  RUNTIME_PIDFILE_RELATIVE_PATH,
} from "./schema.js";
import {
  readPidfile,
  removePidfile,
  runtimePidfilePath,
  type RuntimePidfile,
} from "./pidfile.js";
import { isProcessAlive, type OwnershipProbes } from "./ownership.js";

// ─── Claim ──────────────────────────────────────────────────────────────────

export type ClaimResult =
  | { kind: "claimed"; path: string; warnings: string[] }
  /** Someone else's pidfile (claim or real record) already exists. */
  | { kind: "held"; path: string }
  | { kind: "error"; path: string; reason: string };

/** The sentinel record a claim writes: the claimer, not a spawned group. */
export function claimEntry(command: string): RuntimePidfile {
  return {
    pid: process.pid,
    pgid: null,
    startedAt: Date.now(),
    command,
    state: "claiming",
  };
}

/**
 * Atomically claim `worktreePath` for a `runtime_up`, or report that it is
 * already held. ⛔ Never overwrites: exclusivity is the entire point.
 */
export function claimPidfile(
  worktreePath: string,
  entry: RuntimePidfile,
): ClaimResult {
  const path = runtimePidfilePath(worktreePath);
  const warnings: string[] = [];

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return { kind: "held", path };
    }
    return {
      kind: "error",
      path,
      reason:
        `could not write the runtime_up claim to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Best-effort git hiding, same as writePidfile — losing the claim to a
  // failed hide is not acceptable, so failures are warnings, not aborts.
  const excluded = excludeFromGit(worktreePath, [
    RUNTIME_PIDFILE_RELATIVE_PATH,
    RUNTIME_LOG_RELATIVE_PATH,
  ]);
  warnings.push(...excluded.warnings);

  return { kind: "claimed", path, warnings };
}

// ─── Existing-claim resolution (preflight's first question) ─────────────────

export type ExistingClaim =
  /** No claim in the way (no pidfile, or a real runtime record). */
  | { kind: "none" }
  /** A live (or unknowable) claimer holds the worktree. Do not proceed. */
  | { kind: "held"; reason: string }
  /** A stale claim was released. Preflight may continue. */
  | { kind: "released"; action: string };

/**
 * Resolve a `state: "claiming"` record before the preflight matrix runs.
 *
 * ⛔ The generic verdict machinery must never see a claim: its `pid` is the
 * claiming ORCHESTRATOR, not a spawned leader, so `inspectPidfile` would
 * misread it (the claim's `startedAt` is claim time, not the orchestrator's
 * process start, so the H5 check reports `stale` — and the stale row would
 * then DELETE a live claim, reopening the race).
 */
export function resolveExistingClaim(
  worktreePath: string,
  probes: OwnershipProbes = {},
): ExistingClaim {
  const entry = readPidfile(worktreePath);
  if (!entry || entry.state !== "claiming") return { kind: "none" };

  const alive = probes.isAlive ?? isProcessAlive;
  let claimerAlive: boolean;
  try {
    claimerAlive = alive(entry.pid);
  } catch {
    claimerAlive = true; // fail closed: an unknowable claimer holds the claim
  }

  if (claimerAlive) {
    return {
      kind: "held",
      reason:
        `Another runtime_up (pid ${entry.pid}) is claiming this worktree RIGHT NOW — it has taken ` +
        `the exclusive claim and is about to spawn \`${entry.command}\`. Not starting anything on ` +
        `top of it. Retry shortly: its record will flip to "starting"/"ready" (reuse or wait), or ` +
        `disappear if it failed.`,
    };
  }

  const removed = removePidfile(worktreePath, entry.pid);
  if (!removed.removed) {
    return {
      kind: "held",
      reason:
        `A stale runtime_up claim (dead pid ${entry.pid}) could not be released: ` +
        `${removed.reason ?? "unknown error"}`,
    };
  }
  return {
    kind: "released",
    action:
      `Released a stale runtime_up claim left by pid ${entry.pid}, which died before spawning ` +
      `anything.`,
  };
}
