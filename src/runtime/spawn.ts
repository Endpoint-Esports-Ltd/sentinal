/**
 * Detached spawn into a process group Sentinal owns, with stdout+stderr
 * captured to the worktree's runtime log.
 *
 * ## Why detached at all
 *
 * D3: Sentinal can only own PIDs it started. D5: ownership is recorded in a
 * worktree-local pidfile and enforced by `kill -- -$PGID`. Both collapse unless
 * the child leads its **own** process group — otherwise the group we would
 * signal is the agent host's, and `runtime_stop` becomes a `pkill`-shaped
 * weapon aimed at the editor.
 *
 * ## Two facts established empirically, not read off the docs
 *
 * 1. **`pgid === pid`.** `bun.d.ts:6494-6508` documents a `setsid()` call on
 *    POSIX; `spawn.test.ts` asserts the resulting pgid against `ps`, because
 *    every signal this phase sends is aimed at that number.
 * 2. **`stdio: ["ignore", logFd, logFd]` does NOT hold the parent open.**
 *    `bun.d.ts:6503-6504` warns — inside the same docblock — that stdio "may
 *    keep the parent process alive" and prescribes all-ignore. Measured on
 *    Bun/macOS: a fixture parent using the fd shape exits in ~20ms while the
 *    child lives on. A real file descriptor is not a pipe; nothing in the
 *    parent's event loop refers to it. `spawn.test.ts` re-measures this on
 *    every run, so a Bun regression surfaces as a failing test rather than as
 *    an MCP server that hangs on exit after every `runtime_up`.
 *
 * ## Windows
 *
 * `bun.d.ts:6500-6501` promises only that a detached child "outlives the parent
 * and receives signals independently" — it makes **no process-group guarantee**.
 * {@link resolvePgid} therefore returns `null` there, and teardown degrades to
 * the declared `down` (or fails loudly when there is none). Modelling that as
 * `null` rather than guessing `pid` is the difference between "we cannot stop
 * this" and `kill -- -$PGID` against a stranger.
 */

import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNTIME_LOG_RELATIVE_PATH, RUNTIME_LOG_TAIL_LINES } from "./schema.js";
import { SLOT_ENV_VAR } from "../worktree/slots.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpawnDetachedOptions {
  /** Directory the group runs in. Its cwd is the durable ownership proof. */
  worktreePath: string;
  /** The **already interpolated** `up` command (`loadRuntimeConfig` does that). */
  command: string;
  /** Allocated slot, or `null`/omitted for an unslotted worktree. */
  slot?: number | null;
  /** Extra environment entries, merged over `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface SpawnDetachedResult {
  /** The group leader. Written to the pidfile **immediately**, before polling. */
  pid: number;
  /** `pid` on POSIX; `null` where no process group is guaranteed. */
  pgid: number | null;
  /** Absolute path to the captured log. */
  logPath: string;
  /** The command as spawned, for the human reading a failure message. */
  command: string;
  /** The leader's exit code, or `null` while it is still running. */
  exitCode(): number | null;
  /** Resolves with the leader's exit code. */
  exited: Promise<number>;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function runtimeLogPath(worktreePath: string): string {
  return join(worktreePath, RUNTIME_LOG_RELATIVE_PATH);
}

/**
 * The last `lines` lines of the runtime log, or `""` when there is none.
 *
 * **Log capture is a safety feature, not a convenience.** An agent facing a
 * failed `up` with no logs is blind, and a blind agent improvises — which is
 * the behaviour that produced issue #2. Every failure path in this phase
 * carries a tail.
 */
export function readLogTail(
  worktreePath: string,
  lines: number = RUNTIME_LOG_TAIL_LINES,
): string {
  const path = runtimeLogPath(worktreePath);
  if (!existsSync(path)) return "";
  try {
    const all = readFileSync(path, "utf-8").split("\n");
    // Trailing newline produces a final empty element; drop it so `lines`
    // counts content, not formatting.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ─── Process group ──────────────────────────────────────────────────────────

/**
 * The process group of `pid`, or `null` when it cannot be established.
 *
 * ⛔ `null` means "unknown", and every caller must treat it as "no group to
 * signal". Node exposes no `getpgid`, so this shells out to `ps`; a platform
 * without `ps` (Windows) is exactly a platform without process groups.
 */
export function resolvePgid(pid: number): number | null {
  if (process.platform === "win32") return null;
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const r = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = Number((r.stdout?.toString() ?? "").trim());
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

// ─── Spawn ──────────────────────────────────────────────────────────────────

function buildEnv(
  opts: SpawnDetachedOptions,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(opts.env ?? {}),
  };
  // Two expansion layers (Phase 3): Sentinal's load-time substitution has
  // already rewritten `${SENTINAL_WORKTREE_SLOT}` inside the command. This is
  // the purely additive second layer, for scripts the command *invokes*.
  //
  // ⛔ Never export an invented value. `loader.ts`'s slotlessWarning makes the
  // same argument: an empty or fabricated slot silently points the run at
  // resources that are not this worktree's, most likely the main checkout's.
  if (opts.slot !== null && opts.slot !== undefined) {
    env[SLOT_ENV_VAR] = String(opts.slot);
  } else {
    delete env[SLOT_ENV_VAR];
  }
  return env;
}

/**
 * Start `command` detached, in its own process group, inside `worktreePath`.
 *
 * ⛔ The caller MUST write the pidfile with `state="starting"` from the
 * returned `pid` **before** its first readiness poll. Writing it only on
 * success leaves the whole startup window (up to 60s) with a detached group and
 * no ownership record — the orphan D5 exists to prevent — and the next
 * `runtime_up` then hits "port occupied, no pidfile → fail" and permanently
 * wedges the worktree.
 */
export function spawnDetached(opts: SpawnDetachedOptions): SpawnDetachedResult {
  const logPath = runtimeLogPath(opts.worktreePath);
  mkdirSync(dirname(logPath), { recursive: true });
  // Append, never truncate: the previous failure's evidence is exactly what a
  // human debugging the current one needs.
  const logFd = openSync(logPath, "a");

  const proc = Bun.spawn(["sh", "-c", opts.command], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: opts.worktreePath,
    env: buildEnv(opts),
  });

  const pid = proc.pid;
  // ⚠️ `unref()` returns void — do not chain it. `.pid` is the whole payload,
  // and it must be read before the handle is released.
  proc.unref();

  return {
    pid,
    // ⚠️ `?? pid` on POSIX only. A detaching starter can exit and be reaped
    // before `ps` answers, and reporting `null` would silently discard the
    // group for the flagship `docker compose up -d` case. `setsid()` has just
    // run, so `pid` IS the group — and every signal is ownership-verified
    // before it is sent, so an over-optimistic pgid still cannot kill a
    // stranger. On Windows there is no group to guess at, so `null` stands.
    pgid: resolvePgid(pid) ?? (process.platform === "win32" ? null : pid),
    logPath,
    command: opts.command,
    exitCode: () => proc.exitCode,
    exited: proc.exited,
  };
}
