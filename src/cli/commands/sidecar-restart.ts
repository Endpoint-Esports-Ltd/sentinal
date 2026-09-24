/**
 * `sentinal sidecar restart` — injectable core.
 *
 * Restart backgrounds by default: it stops the old sidecar, WAITS for the old
 * PID to exit (so the old process's `stopSidecar` cleanup cannot delete the
 * new sidecar's socket), then spawns `sentinal sidecar start` DETACHED — in its
 * own process group — so a tool runner killing the invoker's group does not
 * take the new sidecar down. The child runs the normal `start` path, so
 * `assessSidecarStart` and `alreadyRunning` handling apply.
 *
 * `--foreground` keeps the old behaviour: the restart process becomes the
 * sidecar via the shared foreground start path.
 */

export const DEFAULT_EXIT_TIMEOUT_MS = 10_000;

export interface RestartOptions {
  foreground?: boolean;
  httpOnly?: boolean;
  exitTimeoutMs?: number;
}

export interface RestartDeps {
  /** PID recorded for the running sidecar, read BEFORE stopping. */
  readPid: () => number | null;
  /** SIGTERM the verified sidecar; true when a signal was sent. */
  stop: () => boolean;
  /** Resolve true once `pid` is gone, false on timeout. */
  waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>;
  /** Spawn a detached `sidecar start`; returns the child PID. */
  spawnBackground: (opts: { httpOnly?: boolean }) => number | undefined;
  /** Resolve true once the new sidecar answers. */
  waitForReady: () => Promise<boolean>;
  /** Run the foreground start path in THIS process. */
  startForeground: (opts: { httpOnly?: boolean }) => Promise<void>;
  log: (line: string) => void;
}

/** Returns a process exit code (0 = success). */
export async function runRestart(
  opts: RestartOptions,
  deps: RestartDeps,
): Promise<number> {
  const oldPid = deps.readPid();
  const stopped = deps.stop();

  if (stopped && oldPid !== null) {
    deps.log(`Stopping existing sidecar (PID: ${oldPid})...`);
    const timeoutMs = opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
    const exited = await deps.waitForExit(oldPid, timeoutMs);
    if (!exited) {
      deps.log(
        `Old sidecar (PID: ${oldPid}) did not exit within ${timeoutMs}ms — not starting a new one. ` +
          `Check it with \`ps -p ${oldPid}\` and retry.`,
      );
      return 1;
    }
    deps.log("Stopped existing sidecar.");
  }

  if (opts.foreground) {
    await deps.startForeground({ httpOnly: opts.httpOnly });
    return 0;
  }

  let pid: number | undefined;
  try {
    pid = deps.spawnBackground({ httpOnly: opts.httpOnly });
  } catch (err) {
    deps.log(
      `Failed to spawn sidecar: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const ready = await deps.waitForReady();
  if (!ready) {
    deps.log(
      `Sidecar spawned in background (PID: ${pid ?? "unknown"}) but is not reachable yet — ` +
        "check `sentinal sidecar logs`.",
    );
    return 1;
  }
  deps.log(`Sidecar restarted in background (PID: ${pid ?? "unknown"}).`);
  return 0;
}

// ─── Default implementations ────────────────────────────────────────────────

export interface WaitProbes {
  isAlive: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  probes: WaitProbes,
): Promise<boolean> {
  const sleep =
    probes.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = probes.now ?? Date.now;
  const interval = probes.intervalMs ?? 50;
  const deadline = now() + timeoutMs;
  while (probes.isAlive(pid)) {
    if (now() >= deadline) return false;
    await sleep(interval);
  }
  return true;
}

/**
 * Build a spawn command that works for both compiled binaries and source mode.
 * Compiled Bun binaries have argv[1] starting with `/$bunfs/` (virtual FS).
 */
export function buildSpawnCmd(
  subArgs: string[],
  argv1: string = process.argv[1] ?? "",
  execPath: string = process.execPath,
): string[] {
  if (argv1.startsWith("/$bunfs/")) return [execPath, ...subArgs];
  return ["bun", argv1, ...subArgs];
}

type SpawnImpl = (
  cmd: string[],
  opts: {
    stdio: ["ignore", "ignore", "ignore"];
    detached: true;
    env: Record<string, string | undefined>;
  },
) => { pid: number; unref: () => void };

/**
 * Spawn `sentinal <subArgs>` in its own process group (Bun.spawn honours
 * `detached` — verified on Bun 1.3.10: the child gets a new PGID).
 */
export function spawnDetachedSidecar(
  subArgs: string[],
  spawnImpl: SpawnImpl = (cmd, opts) => Bun.spawn(cmd, opts),
): number {
  const proc = spawnImpl(buildSpawnCmd(subArgs), {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env },
  });
  proc.unref();
  return proc.pid;
}
