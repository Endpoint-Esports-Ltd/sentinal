/**
 * The worktree-local pidfile — D5's substitute for a process supervisor.
 *
 * ## Why a file and not a table
 *
 * Issue #2 proposed recording PIDs/PGIDs "in Sentinal state". Implemented
 * literally that means a `runtime_processes` table, a migration, a warm
 * registry on `SidecarContext`, a sidecar route, a client method and a
 * reconciliation sweep on sidecar start — a small reimplementation of
 * `foreman`. A worktree-local file keeps 100% of the ownership property (a
 * group Sentinal started is still a group Sentinal owns) at roughly a third of
 * the surface: staleness is evaluated **on read**, so there is no sweep, and
 * the record dies with the worktree.
 *
 * Shape precedent: `src/sidecar/lifecycle.ts` (`readSidecarPid` :18-28,
 * `removeSidecarPid` :30-37, and the PID-ownership guard in
 * `cleanupSidecarFiles` :211-231) and `src/dashboard/lifecycle.ts`.
 *
 * ## Two invariants
 *
 * 1. **Written on spawn with `state="starting"`**, flipped to `"ready"` in
 *    place. See {@link RUNTIME_PIDFILE_RELATIVE_PATH} for why.
 * 2. **Every read re-derives liveness and ownership.** {@link inspectPidfile}
 *    never reports `owned` for a process it cannot prove belongs to this
 *    worktree — including the "we could not check" case.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { excludeFromGit } from "../worktree/git-exclude.js";
import {
  RUNTIME_LOG_RELATIVE_PATH,
  RUNTIME_PIDFILE_RELATIVE_PATH,
} from "./schema.js";
import {
  isProcessAlive,
  processBelongsToWorktree,
  listGroupMembers,
  type OwnershipProbes,
  type GroupProbes,
  type GroupProbeResult,
} from "./ownership.js";
import { verifyStartTime, type StartTimeProbes } from "./proc-start.js";

// ─── Shape ──────────────────────────────────────────────────────────────────

/**
 * ⛔ `pgid` is `number | null`. `bun.d.ts:6494-6508` documents `setsid()` on
 * POSIX (so `pgid === pid`) but makes **no process-group guarantee at all** on
 * Windows — it says only that the child "outlives the parent and receives
 * signals independently". Modelling that as `null` is the honest encoding;
 * faking a pgid there would produce a `kill -- -$PGID` against a group that
 * may not exist, or worse, someone else's.
 */
export const RuntimePidfileSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive().nullable(),
  startedAt: z.number().int().nonnegative(),
  /** The interpolated `up` command, for the human reading a failure message. */
  command: z.string(),
  state: z.enum(["claiming", "starting", "ready"]), // "claiming": M4c's pre-spawn claim, see pidfile-claim.ts
});

export type RuntimePidfile = z.infer<typeof RuntimePidfileSchema>;

export interface PidfileWriteResult {
  path: string;
  written: boolean;
  /**
   * Non-fatal problems — chiefly `excludeFromGit` tier-3 refusals. ⛔ Surface
   * these; a pidfile visible to `git status` is a file someone will commit.
   */
  warnings: string[];
}

export interface PidfileOpResult {
  ok: boolean;
  reason?: string;
}

export interface PidfileRemoveResult {
  removed: boolean;
  reason?: string;
}

/** What a read of the pidfile actually establishes. Feeds the D12 preflight. */
export type PidfileVerdict =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  /** The recorded leader is dead. The group may still be orphaned — check. */
  | { kind: "stale"; entry: RuntimePidfile; reason: string }
  /** Alive, but NOT provably ours. Never signal this. */
  | { kind: "foreign"; entry: RuntimePidfile; reason: string }
  | { kind: "owned"; entry: RuntimePidfile };

// ─── Paths ──────────────────────────────────────────────────────────────────

export function runtimePidfilePath(worktreePath: string): string {
  return join(worktreePath, RUNTIME_PIDFILE_RELATIVE_PATH);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Record the group we just started.
 *
 * ⛔ Hiding from git is **best-effort**; losing the ownership record is not
 * acceptable. The file is written first, then hidden, and a failure to hide is
 * reported in `warnings` rather than aborting.
 */
export function writePidfile(
  worktreePath: string,
  entry: RuntimePidfile,
): PidfileWriteResult {
  const path = runtimePidfilePath(worktreePath);
  const warnings: string[] = [];

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", "utf-8");

  // In a Sentinal-installed project this hits excludeFromGit tier 1
  // (inherited): `.sentinal/.gitignore` denies all with `*`, so nothing is
  // written. Elsewhere it creates a worktree-local, self-ignoring .gitignore.
  const excluded = excludeFromGit(worktreePath, [
    RUNTIME_PIDFILE_RELATIVE_PATH,
    RUNTIME_LOG_RELATIVE_PATH,
  ]);
  warnings.push(...excluded.warnings);

  return { path, written: true, warnings };
}

/**
 * Flip `state` to `"ready"` once the readiness probe has passed.
 *
 * Refuses if a different pid has since claimed the file — the same
 * PID-ownership guard `cleanupSidecarFiles` (`src/sidecar/lifecycle.ts:211-218`)
 * applies before deleting.
 */
export function markPidfileReady(
  worktreePath: string,
  expectPid: number,
): PidfileOpResult {
  const current = readPidfile(worktreePath);
  if (!current) {
    return {
      ok: false,
      reason: `${RUNTIME_PIDFILE_RELATIVE_PATH} is missing or unreadable — refusing to mark ready.`,
    };
  }
  if (current.pid !== expectPid) {
    return {
      ok: false,
      reason:
        `${RUNTIME_PIDFILE_RELATIVE_PATH} now records pid ${current.pid}, not ${expectPid} — ` +
        `another runtime_up claimed this worktree. Refusing to overwrite it.`,
    };
  }
  writeFileSync(
    runtimePidfilePath(worktreePath),
    JSON.stringify({ ...current, state: "ready" }, null, 2) + "\n",
    "utf-8",
  );
  return { ok: true };
}

/**
 * Delete the record. Idempotent — an absent file is a success, because teardown
 * must be safe to call twice and safe when nothing was ever started.
 *
 * @param expectPid when supplied, refuse if a different pid now owns the file.
 */
export function removePidfile(
  worktreePath: string,
  expectPid?: number,
): PidfileRemoveResult {
  const path = runtimePidfilePath(worktreePath);
  if (!existsSync(path)) return { removed: true };

  if (expectPid !== undefined) {
    const current = readPidfile(worktreePath);
    if (current && current.pid !== expectPid) {
      return {
        removed: false,
        reason:
          `${RUNTIME_PIDFILE_RELATIVE_PATH} records pid ${current.pid}, not ${expectPid} — ` +
          `refusing to delete another invocation's ownership record.`,
      };
    }
  }

  try {
    rmSync(path, { force: true });
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      reason: `could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** The record, or `null` when absent, corrupt or structurally wrong. */
export function readPidfile(worktreePath: string): RuntimePidfile | null {
  const path = runtimePidfilePath(worktreePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = RuntimePidfileSchema.safeParse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Liveness, defaulting to **alive** when the probe itself fails.
 *
 * ⛔ The asymmetry is deliberate. "Alive" routes to the `owned`/`foreign`
 * branches, where a signal still has to clear `processBelongsToWorktree`.
 * "Dead" routes to `stale`, which is what authorises the orphan **group** reap
 * — the most dangerous action in this phase. An unknowable liveness must not
 * unlock it.
 */
function probeAlive(pid: number, probes: OwnershipProbes): boolean {
  const alive = probes.isAlive ?? isProcessAlive;
  try {
    return alive(pid);
  } catch {
    return true;
  }
}

/**
 * Re-derive liveness and ownership from the record.
 *
 * ⛔ Ownership that cannot be **verified** is reported as `foreign`, not
 * `owned`. The two are conflated deliberately: the correct response to both is
 * identical — do not signal.
 */
export function inspectPidfile(
  worktreePath: string,
  probes: OwnershipProbes & StartTimeProbes = {},
): PidfileVerdict {
  const path = runtimePidfilePath(worktreePath);
  if (!existsSync(path)) return { kind: "absent" };

  const entry = readPidfile(worktreePath);
  if (!entry) {
    return {
      kind: "unreadable",
      reason:
        `${path} exists but could not be parsed as a runtime pidfile. It is not safe to ` +
        `assume anything about it — delete it by hand once you have confirmed nothing is ` +
        `running for this worktree.`,
    };
  }

  if (!probeAlive(entry.pid, probes)) {
    return {
      kind: "stale",
      entry,
      reason:
        `recorded leader pid ${entry.pid} is no longer alive. The process GROUP ` +
        `(pgid ${entry.pgid ?? "unknown"}) may still hold resources — a shell wrapper ` +
        `without \`exec\` outlives nothing but its children outlive it.`,
    };
  }

  if (!processBelongsToWorktree(entry.pid, worktreePath, probes)) {
    return {
      kind: "foreign",
      entry,
      reason:
        `pid ${entry.pid} is alive but nothing proves it belongs to ${worktreePath} — ` +
        `neither its command line nor its working directory references this worktree. ` +
        `Most likely the PID was recycled onto an unrelated process. REFUSING to treat ` +
        `it as ours; it will not be signalled.`,
    };
  }

  // H5: cmdline/cwd proof is forgeable by accident (a recycled leader PID on
  // a worktree-cwd process passes above). Start time decides — proc-start.ts.
  const started = verifyStartTime(entry.pid, entry.startedAt, probes);
  if (started.kind === "mismatch") {
    return { kind: "stale", entry, reason: started.reason };
  }
  if (started.kind === "unknown") {
    return { kind: "foreign", entry, reason: started.reason };
  }

  return { kind: "owned", entry };
}

// ─── Guard 5 input ──────────────────────────────────────────────────────────

/** What `worktree_cleanup --force`'s guard 5 needs, and nothing more. */
export interface LiveRuntimeVerdict {
  /** True when this worktree may still own running processes. */
  live: boolean;
  /** Human-facing: what was found, and what to do about it. */
  detail?: string;
}

/**
 * Does `worktreePath` still own running processes?
 *
 * ⛔ **Conservative in the OPPOSITE direction to {@link inspectPidfile}.** That
 * function refuses to call anything "ours" it cannot prove, because its answer
 * authorises a *signal*. This one's answer authorises a **directory deletion**,
 * so anything it cannot rule out counts as live:
 *
 * | Cost of a wrong answer | |
 * | --- | --- |
 * | false "nothing running" | a live process whose cwd has just been deleted — the orphan this tier exists to prevent |
 * | false "something running" | one skipped cleanup and a warning |
 *
 * The asymmetry is the whole design. An unreadable pidfile and an
 * alive-but-unprovable pid both report `live: true`.
 */
export function ownsLiveRuntime(
  worktreePath: string,
  probes: GroupProbes & StartTimeProbes = {},
): LiveRuntimeVerdict {
  const verdict = inspectPidfile(worktreePath, probes);

  switch (verdict.kind) {
    case "absent":
      return { live: false };

    case "unreadable":
      return {
        live: true,
        detail:
          `${verdict.reason} Treating this worktree as possibly-running and NOT removing it — an ` +
          `unreadable ownership record is not permission to delete a directory.`,
      };

    case "owned":
      return {
        live: true,
        detail:
          `pid ${verdict.entry.pid} (process group ${verdict.entry.pgid ?? "unknown"}) is running ` +
          `from this worktree. Stop it with runtime_stop before removing the directory.`,
      };

    case "foreign":
      return {
        live: true,
        detail:
          `${verdict.reason} Because that could not be resolved, the directory is NOT being ` +
          `removed. Confirm by hand what pid ${verdict.entry.pid} is, then delete ` +
          `${RUNTIME_PIDFILE_RELATIVE_PATH}.`,
      };

    case "stale": {
      // The leader is gone, but a shell wrapper without `exec` outlives nothing
      // while its children outlive it. The GROUP is the real question.
      const pgid = verdict.entry.pgid;
      const probe: GroupProbeResult =
        pgid === null
          ? { kind: "members", members: [] }
          : listGroupMembers(pgid, probes);

      // ⛔ "We could not enumerate the group" is NOT "the group is gone". This
      // verdict authorises a directory deletion, so the one answer it must
      // never round down is the one it does not have.
      if (probe.kind === "unknown") {
        return {
          live: true,
          detail:
            `the recorded leader (pid ${verdict.entry.pid}) is gone, but ${probe.reason}. Its ` +
            `process group may still hold live members, so this directory is NOT being removed — ` +
            `deleting it would orphan them with their working directory gone. Confirm by hand ` +
            `with \`ps -A -o pid=,pgid=,command= | awk '$2 == ${pgid}'\`, then delete ` +
            `${RUNTIME_PIDFILE_RELATIVE_PATH}.`,
        };
      }
      if (probe.members.length === 0) return { live: false };
      return {
        live: true,
        detail:
          `the recorded leader (pid ${verdict.entry.pid}) is gone, but process group ${pgid} still ` +
          `has ${probe.members.length} live member(s): ${probe.members.join(", ")}. Removing this ` +
          `directory would orphan them. Run runtime_stop first.`,
      };
    }
  }
}
