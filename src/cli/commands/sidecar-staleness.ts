/**
 * Stale-sidecar warning for `sentinal update` (plan 2026-09-24, Task 9).
 *
 * After an update the long-lived sidecar keeps running the OLD binary until
 * it retires. This tells the user so, in one line, and points at the
 * (background, Task 4) `sentinal sidecar restart`.
 *
 * ⛔ Uses `SidecarClient.connect()` ONLY — never `connectWithRetry()` or
 * `autoStartSidecar()`. Starting a sidecar just to ask its version would
 * start the NEW version and make the check meaningless (and leave a process
 * the user never asked for).
 *
 * Side effect worth knowing: when this runs inside the NEW compiled binary,
 * `connect()` itself calls `noteVersionSkew`, which — for a newer compiled
 * client — fires `requestRetire` at the stale sidecar. So the update does not
 * only warn: it also starts healing the stale sidecar (it retires as soon as
 * no sessions are active).
 */

import { SidecarClient } from "../../sidecar/client.js";

interface HealthReporter {
  health(): Promise<{ version?: string }>;
}

export interface StaleSidecarDeps {
  /** Default `SidecarClient.connect()` — returns null when none is running. */
  connect?: () => Promise<HealthReporter | null>;
  /** Default `console.log`. */
  log?: (line: string) => void;
  /** Give up silently after this long (a wedged sidecar must not hang update). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export function formatStaleSidecarWarning(
  runningVersion: string,
  installedVersion: string,
): string {
  return (
    `Running sidecar is v${runningVersion} (installed v${installedVersion}). ` +
    `It will retire when no sessions are active, or run 'sentinal sidecar restart' to switch now.`
  );
}

async function probeVersion(
  connect: () => Promise<HealthReporter | null>,
): Promise<string | undefined> {
  const client = await connect();
  if (!client) return undefined;
  const health = await client.health();
  return health?.version;
}

/**
 * Print one warning line when a running sidecar reports a version different
 * from `expectedVersion`. Silent when no sidecar runs, it reports no version,
 * or the versions match. Never throws. Returns the printed line, or null.
 */
export async function warnIfSidecarStale(
  expectedVersion: string,
  deps: StaleSidecarDeps = {},
): Promise<string | null> {
  const connect = deps.connect ?? (() => SidecarClient.connect());
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const running = await Promise.race([probeVersion(connect), timeout]);
    if (!running || running === expectedVersion) return null;
    const line = formatStaleSidecarWarning(running, expectedVersion);
    log(line);
    return line;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
