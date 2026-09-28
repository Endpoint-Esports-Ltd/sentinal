/**
 * `runWorktreeSetup` — the once-per-worktree `setup` command (orca D5).
 *
 * ## Lifecycle position
 *
 * Phase 3 cut `bootstrap` "until it has a defined lifecycle position (once per
 * worktree creation, before first up)". This is that position, under the name
 * `setup`: worktree code (`ensureWorktree`, create/adopt) calls this ONCE, after
 * the row is inserted and the worktree seeded. It is:
 *
 * - **never run by `runtime_up`** — `up` may run many times, `setup` once;
 * - **never part of a rollback** — a failed `setup` is reported as a warning,
 *   the worktree stays (a half-installed tree is still the user's work);
 * - **never throwing** — every outcome is a {@link WorktreeSetupResult}.
 *
 * ## Why it lives here and is injected
 *
 * `src/worktree/` must import nothing from `src/runtime/`
 * (`no-module-cycle.test.ts`). Worktree code therefore receives this function
 * (and an already-loaded contract) from its caller, the same way the runtime
 * config is threaded down in `src/mcp/server.ts`.
 *
 * ## Shell and log — the same mechanism as `up`
 *
 * `sh -c <command>` with `cwd` = the worktree, stdout+stderr appended (never
 * truncated) to `.sentinal/runtime.log` behind a header, exactly as
 * `spawn.ts`'s `spawnDetached` does for `up`. Unlike `up` it is awaited, not
 * detached: setup is a finite command, and a timeout kills it.
 *
 * ⚠️ The timeout kills the `sh` LEADER only (SIGKILL), never a process group:
 * `runtime_stop` is the codebase's only group-signalling path
 * (`sentinal-mcp-servers.md`). `sh -c` execs a single simple command in place,
 * so for the common `bun install` / `npm ci` the leader IS the installer.
 */

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { SLOT_TOKEN, sentinalTokenNames } from "./interpolate.js";
import { RUNTIME_LOG_TAIL_LINES, type RuntimeConfig } from "./schema.js";
import { runtimeLogPath } from "./spawn.js";

/** 10 minutes: a cold `bun install` / `npm ci` on a slow network fits. */
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;

/** After a timeout kill, how long to wait for the leader to be reaped. */
const KILL_SETTLE_MS = 2_000;

export interface WorktreeSetupResult {
  /** True when a setup process was actually started. */
  ran: boolean;
  /** True on exit 0 — and when there was nothing to run. */
  ok: boolean;
  /** The exit code, or `null` when it never ran or was killed on timeout. */
  exitCode: number | null;
  timedOut: boolean;
  /** Last {@link RUNTIME_LOG_TAIL_LINES} lines of THIS run's output. */
  tail: string;
  /** Why a declared setup did not run or could not complete. */
  reason?: string;
}

export interface SetupSpawnOptions {
  /** The interpolated `setup` command, run as `sh -c <command>`. */
  command: string;
  /** The worktree root. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Append-mode fd of `.sentinal/runtime.log`, for stdout AND stderr. */
  logFd: number;
}

export interface SetupProcess {
  exited: Promise<number>;
  kill(): void;
}

export interface RunWorktreeSetupOptions {
  timeoutMs?: number;
  /** The worktree's slot, exported as `SENTINAL_WORKTREE_SLOT` when set. */
  slot?: number | null;
  /** Injectable for tests. Defaults to `sh -c` via `Bun.spawn`. */
  spawn?: (opts: SetupSpawnOptions) => SetupProcess;
}

function defaultSpawn(opts: SetupSpawnOptions): SetupProcess {
  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", opts.logFd, opts.logFd],
  });
  return { exited: proc.exited, kill: () => proc.kill("SIGKILL") };
}

/** Same rule as `spawn.ts`: export a real slot, never an inherited/invented one. */
function buildEnv(slot: number | null | undefined) {
  const env: Record<string, string | undefined> = { ...process.env };
  if (slot !== null && slot !== undefined) env[SLOT_TOKEN] = String(slot);
  else delete env[SLOT_TOKEN];
  return env;
}

function tailFrom(logPath: string, offset: number): string {
  try {
    const out = readFileSync(logPath).subarray(offset).toString("utf-8");
    const lines = out.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-RUNTIME_LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const failed = (reason: string, over: Partial<WorktreeSetupResult> = {}) => ({
  ran: false,
  ok: false,
  exitCode: null,
  timedOut: false,
  tail: "",
  reason,
  ...over,
});

/**
 * Run the contract's `setup` once in `worktreePath`. Pass the contract AFTER
 * `loadRuntimeConfig`, so the slot token has already been substituted.
 *
 * ⛔ Never throws.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  contract: Pick<RuntimeConfig, "setup"> | null | undefined,
  opts: RunWorktreeSetupOptions = {},
): Promise<WorktreeSetupResult> {
  const command = contract?.setup;
  if (!command) {
    return { ran: false, ok: true, exitCode: null, timedOut: false, tail: "" };
  }

  // ⛔ Same hazard `runtime_up` refuses on: `sh -c` would expand a surviving
  // token to the EMPTY STRING and aim setup at the slotless checkout's resources.
  const surviving = sentinalTokenNames(command);
  if (surviving.length > 0) {
    return failed(
      `setup still contains ${surviving.map((t) => `\${${t}}`).join(", ")} after interpolation — this ` +
        `worktree has no slot to substitute. Nothing was run. Do NOT substitute a value yourself; give the ` +
        `worktree a slot first.`,
    );
  }

  try {
    if (!statSync(worktreePath).isDirectory()) {
      return failed(`${worktreePath} is not a directory. Nothing was run.`);
    }
  } catch (err) {
    return failed(`Worktree ${worktreePath} is not usable: ${message(err)}`);
  }

  const logPath = runtimeLogPath(worktreePath);
  let fd: number;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    fd = openSync(logPath, "a");
  } catch (err) {
    return failed(`Could not open ${logPath}: ${message(err)}`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const started = Date.now();
  try {
    writeSync(
      fd,
      `\n=== [sentinal] setup ${new Date(started).toISOString()} — \`${command}\` in ${worktreePath} ===\n`,
    );
    const offset = fstatSync(fd).size;

    let proc: SetupProcess;
    try {
      proc = (opts.spawn ?? defaultSpawn)({
        command,
        cwd: worktreePath,
        env: buildEnv(opts.slot),
        logFd: fd,
      });
    } catch (err) {
      writeSync(fd, `=== [sentinal] setup could not start: ${message(err)}\n`);
      return failed(`Could not start setup \`${command}\`: ${message(err)}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOutSignal = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const exited = proc.exited.catch(() => -1);
    const outcome = await Promise.race([exited, timedOutSignal]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      try {
        proc.kill();
      } catch {
        // Already gone — the race was lost by milliseconds.
      }
      await Promise.race([exited, Bun.sleep(KILL_SETTLE_MS)]);
      const tail = tailFrom(logPath, offset);
      writeSync(
        fd,
        `=== [sentinal] setup timed out after ${timeoutMs}ms and was killed\n`,
      );
      return failed(
        `setup \`${command}\` timed out after ${timeoutMs}ms and was killed.`,
        { ran: true, timedOut: true, tail },
      );
    }

    const tail = tailFrom(logPath, offset);
    const ms = Date.now() - started;
    writeSync(fd, `=== [sentinal] setup exited ${outcome} after ${ms}ms\n`);
    if (outcome === 0) {
      return { ran: true, ok: true, exitCode: 0, timedOut: false, tail };
    }
    return failed(`setup \`${command}\` exited with code ${outcome}.`, {
      ran: true,
      exitCode: outcome,
      tail,
    });
  } catch (err) {
    return failed(`setup \`${command}\` failed: ${message(err)}`);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do with a close failure.
    }
  }
}
