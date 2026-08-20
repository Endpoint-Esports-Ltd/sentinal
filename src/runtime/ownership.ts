/**
 * Process-ownership verification — the single gate in front of every signal
 * Sentinal sends.
 *
 * ## The one rule
 *
 * **Refuse when unsure.** Every function here returns "not ours" on any probe
 * failure, unparsable output, or missing tool. Signalling a PID we cannot prove
 * we started is the same error class as the `pkill -f` this master plan exists to
 * eliminate, and PIDs (and PGIDs, drawn from the same wrapping space) are reused
 * aggressively on a busy machine.
 *
 * That rule applies to **enumeration** as much as to identity: a `ps` that could
 * not answer is not evidence of an empty group. See {@link GroupProbeResult}.
 *
 * ## Why cwd and not just the command line
 *
 * The canonical precedent — `processBelongsToSandbox` at
 * `tests/e2e/harness/sandbox.ts:320-331` — checks only `ps -o command=`. That
 * works there because the sandbox HOME appears in every command line it cares
 * about. It does **not** generalise: a realistic `up` is `npm run dev`, which
 * execs into a `node` whose argv references the worktree nowhere. The child's
 * **cwd** is the durable proof, because `spawnDetached` starts the group inside
 * the worktree and cwd is inherited. Both probes are consulted; either one
 * matching is proof, neither matching (or both failing) is a refusal.
 */

import { sep } from "node:path";

/**
 * Injectable probes. Production uses `ps`/`lsof`; tests inject deterministic
 * stubs, because the interesting cases (PID reuse, an unavailable `ps`) cannot
 * be produced on demand.
 */
export interface OwnershipProbes {
  /** Full command line of `pid`, or `null` when it cannot be determined. */
  commandOf?(pid: number): string | null;
  /** Current working directory of `pid`, or `null` when undeterminable. */
  cwdOf?(pid: number): string | null;
  /**
   * Liveness. ⛔ Injectable at THIS level, not only on {@link GroupProbes},
   * because `inspectPidfile` turns on it: `stale` vs `owned` is the difference
   * between the orphan-reap path and the reuse path, and neither can be
   * exercised by a test that has to find a real PID in the right state.
   */
  isAlive?(pid: number): boolean;
}

export interface GroupProbes extends OwnershipProbes {
  /**
   * PIDs currently in process group `pgid`, or **`null` when the group could
   * not be enumerated at all** (`ps` missing / non-zero / unparsable).
   */
  listGroup?(pgid: number): number[] | null;
}

/**
 * The outcome of enumerating a process group.
 *
 * ⛔ `members: []` and `unknown` are DIFFERENT FACTS with opposite correct
 * responses, and must never share an encoding:
 *
 * | Result | Teardown | Guard 5 (authorises a deletion) |
 * | --- | --- | --- |
 * | `members: []` | success — remove the record | not live — deletion allowed |
 * | `unknown` | **refuse — KEEP the record** | **live — deletion refused** |
 *
 * This mirrors the asymmetry already applied to liveness (`probeAlive`,
 * `safeAlive`): an unknowable answer resolves to the option that cannot orphan
 * a process.
 */
export type GroupProbeResult =
  { kind: "members"; members: number[] } | { kind: "unknown"; reason: string };

// ─── Liveness ───────────────────────────────────────────────────────────────

/**
 * Does a process with this PID exist? `kill(pid, 0)` sends no signal.
 *
 * Duplicated rather than imported from `src/dashboard/lifecycle.ts:48` on
 * purpose: that module pulls in the dashboard's HTTP probes and CLI discovery,
 * and this one is on the hot path of a spawn.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive, but by
    // definition not ours, and `processBelongsToWorktree` will say so.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// ─── Real probes ────────────────────────────────────────────────────────────

function realCommandOf(pid: number): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (r.stdout?.toString() ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * cwd of `pid`. `/proc` on Linux, `lsof` on macOS/BSD. Anything unexpected —
 * including Windows, which has neither — yields `null`, i.e. "unproven".
 */
function realCwdOf(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      // Lazily required to keep this file free of a top-level fs dependency.
      const { readlinkSync } = require("node:fs") as typeof import("node:fs");
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const r = Bun.spawnSync(
      ["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { stdout: "pipe", stderr: "ignore" },
    );
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      if (line.startsWith("n")) return line.slice(1).trim();
    }
    return null;
  } catch {
    return null;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** `child` is `root` itself or lives underneath it. Prefix-safe. */
function isUnder(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The symlink-resolved form of `path`, or `path` itself when unresolvable.
 *
 * ⚠️ Not cosmetic. On macOS `/var` is a symlink to `/private/var`, so a worktree
 * under `$TMPDIR` is handed to us as `/var/folders/…` while `lsof` reports the
 * process's cwd as `/private/var/folders/…`. Comparing literally makes ownership
 * **unprovable**, and unprovable means refuse — so `runtime_stop` would decline
 * to stop a process it demonstrably started. This widens nothing: the two
 * strings name the same directory.
 */
function realpathOrSelf(path: string): string {
  try {
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ─── Ownership ──────────────────────────────────────────────────────────────

/**
 * Can we PROVE that `pid` belongs to `worktreePath`?
 *
 * ⛔ A `false` here must always be read as "do not signal". It conflates "this
 * is somebody else's process" with "we could not tell", deliberately: both have
 * exactly the same correct response.
 */
export function processBelongsToWorktree(
  pid: number,
  worktreePath: string,
  probes: OwnershipProbes = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!worktreePath) return false;

  const commandOf = probes.commandOf ?? realCommandOf;
  const cwdOf = probes.cwdOf ?? realCwdOf;

  const real = realpathOrSelf(worktreePath);

  const command = safe(() => commandOf(pid), null);
  if (command && (command.includes(worktreePath) || command.includes(real))) {
    return true;
  }

  const cwd = safe(() => cwdOf(pid), null);
  if (cwd && (isUnder(cwd, worktreePath) || isUnder(cwd, real))) return true;

  return false;
}

// ─── Process groups ─────────────────────────────────────────────────────────

/**
 * PIDs whose process group is exactly `pgid`, or `null` when `ps` could not be
 * made to answer.
 *
 * ⚠️ **`ps -o pid= -g <pgid>` is NOT portable process-group selection**, which
 * is why this enumerates everything and filters. **Darwin** `ps(1)` documents
 * `-g` as _"Ignored; for compatibility with earlier versions of ps"_ — it
 * degrades to a bare `ps -o pid=` (the user's controlling-terminal processes).
 * **Linux/procps** reads `-g grplist` as a **session** id, not a pgid; since
 * `spawnDetached` uses `setsid()` that returns a superset, which is benign but
 * means the verification witness may come from a different group than the one
 * about to be signalled. `ps -A -o pid=,pgid=` is exact on both.
 */
function realListGroup(pgid: number): number[] | null {
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    const pids: number[] = [];
    let parsedAnyRow = false;
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      parsedAnyRow = true;
      const pid = Number(m[1]);
      if (Number(m[2]) === pgid && Number.isInteger(pid) && pid > 1) {
        pids.push(pid);
      }
    }
    // `ps -A` always lists at least this process. Zero parsable rows means the
    // output shape was not what we expected — that is "unknown", not "empty".
    return parsedAnyRow ? pids : null;
  } catch {
    return null;
  }
}

/**
 * The **live** members of process group `pgid`, proven or not — or `unknown`
 * when the group could not be enumerated.
 *
 * ⛔ Exists alongside {@link verifiedGroupMembers} because teardown must tell
 * THREE situations apart that "verified members is empty" collapses together:
 * the group is genuinely **gone** (a success); it has **live members none of
 * which can be proven ours** (REFUSE, naming the pids in the way); it **could
 * not be enumerated** (REFUSE, and keep the record). Answering "success" to
 * either of the last two leaves an orphan running while reporting it cleaned up;
 * answering "refuse" to the first wedges every teardown of a stopped runtime.
 */
export function listGroupMembers(
  pgid: number,
  probes: GroupProbes = {},
): GroupProbeResult {
  // pgid 0/1 is the init/kernel group, which we can never have created — a
  // definite "no members of ours", not a failure to look.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return { kind: "members", members: [] };
  }

  const listGroup = probes.listGroup ?? realListGroup;
  const alive = probes.isAlive ?? isProcessAlive;

  let raw: number[] | null;
  try {
    raw = listGroup(pgid);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      kind: "unknown",
      reason: `enumerating process group ${pgid} FAILED: ${why}`,
    };
  }
  if (raw === null) {
    return {
      kind: "unknown",
      reason:
        `process group ${pgid} could not be enumerated — \`ps\` was unavailable, exited non-zero, ` +
        `or produced output that could not be parsed`,
    };
  }

  return {
    kind: "members",
    members: raw.filter((pid) => pid > 1 && safe(() => alive(pid), false)),
  };
}

/**
 * The members of process group `pgid` whose ownership by `worktreePath` we can
 * actually prove.
 *
 * ⛔ **This is the orphan-reap gate.** With a dead leader, leader-PID
 * verification is structurally impossible and the PGID may already have been
 * recycled onto an unrelated group. An empty result means **refuse to signal**
 * — never "probably fine". A failed enumeration is likewise empty: it proves
 * nothing, and proving nothing is a refusal.
 */
export function verifiedGroupMembers(
  pgid: number,
  worktreePath: string,
  probes: GroupProbes = {},
): number[] {
  const probe = listGroupMembers(pgid, probes);
  if (probe.kind === "unknown") return [];
  return probe.members.filter((pid) =>
    processBelongsToWorktree(pid, worktreePath, probes),
  );
}

// ─── The signal gate ────────────────────────────────────────────────────────

export type SignalGateVerdict =
  /** Cleared to signal. `witness` is the member that proved it, if any. */
  | { kind: "allow"; witness: number | null }
  /** Nothing is left in the group — a SUCCESS, not a refusal. */
  | { kind: "gone" }
  /** Live processes exist but none is provably ours. Do not signal. */
  | { kind: "refuse"; reason: string };

export interface SignalGateQuery {
  pgid: number;
  /** The pid recorded as the group's leader. */
  leaderPid: number;
  /** Has that leader itself been proven alive AND ours? */
  leaderVerified: boolean;
  worktreePath: string;
  probes?: GroupProbes;
}

/**
 * ⛔ **The single decision in front of every `kill -- -$PGID` Sentinal sends.**
 *
 * Two callers ask exactly this question — teardown, and the orphan row of
 * `runtime_up`'s preflight — so it lives here rather than in either of them.
 * Two copies of a rule this dangerous is one copy too many.
 *
 * - A **verified leader whose pgid equals its own pid** is the `setsid()` case:
 *   the leader *is* the group, and it has already been proven ours. Allow.
 * - Any other shape means the group's provenance is unestablished — most
 *   importantly a **dead leader**, where leader-PID verification is
 *   structurally impossible and the recycled pgid may already belong to a
 *   stranger. Enumerate live members and require at least one that provably
 *   references this worktree.
 * - **No live members at all** is `gone`, not `refuse`: there is nothing to
 *   signal, so the caller should clean up its record and report success.
 * - **Enumeration that FAILED** is `refuse`, never `gone`. A `ps` that could not
 *   answer is not evidence of an empty group, and `gone` is read by teardown as
 *   success — deleting the ownership record for a group that may still be
 *   running, leaving an orphan nothing can find again.
 */
export function maySignalGroup(query: SignalGateQuery): SignalGateVerdict {
  const { pgid, leaderPid, leaderVerified, worktreePath } = query;
  const probes = query.probes ?? {};

  if (leaderVerified && pgid === leaderPid) {
    return { kind: "allow", witness: null };
  }

  const live = listGroupMembers(pgid, probes);
  if (live.kind === "unknown") {
    return {
      kind: "refuse",
      reason:
        `REFUSING to act on process group ${pgid}: ${live.reason}. Verification is therefore ` +
        `impossible, so this group will NOT be signalled AND the ownership record will NOT be ` +
        `deleted — a failed probe is not evidence that the group is gone, and discarding the ` +
        `record would leave an orphan nothing can find again. Remedy: make \`ps\` work, or run ` +
        `\`ps -A -o pid=,pgid=,command= | awk '$2 == ${pgid}'\` yourself, stop what you ` +
        `recognise as belonging to ${worktreePath}, then delete .sentinal/runtime.pid.`,
    };
  }
  if (live.members.length === 0) return { kind: "gone" };

  const verified = verifiedGroupMembers(pgid, worktreePath, probes);
  if (verified.length === 0) {
    return {
      kind: "refuse",
      reason:
        `REFUSING to signal process group ${pgid}. Its recorded leader (pid ${leaderPid}) is gone or ` +
        `unverifiable, so leader-PID verification is structurally impossible — and PGIDs are drawn ` +
        `from the same wrapping space as PIDs, so ${pgid} may already belong to an unrelated group. ` +
        `Of its ${live.members.length} live member(s) (${live.members.join(", ")}), NONE ` +
        `references ${worktreePath} by command line or working directory. Killing this group is ` +
        `the same class of error as \`pkill -f\`. Remedy: inspect ` +
        `\`ps -A -o pid=,pgid=,command= | awk '$2 == ${pgid}'\` yourself (\`ps -g\` is NOT ` +
        `portable group selection), stop what you recognise, then delete .sentinal/runtime.pid.`,
    };
  }

  return { kind: "allow", witness: verified[0]! };
}
