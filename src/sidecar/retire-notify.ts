/**
 * Retire Notify — once-per-version version-skew signal
 *
 * When the running sidecar is older than the installed binary, surface it
 * through the two channels that actually reach a human:
 *   1. a `notifications` row (dashboard + SessionStart readers), and
 *   2. a `sidecar.log` line (`sentinal sidecar logs` — no dashboard needed).
 *
 * Shape mirrors `notifyVectorUnavailableOnce` (vector-stats.ts): check a
 * settings key → set it → notify → return whether it fired. The key is
 * scoped by the INSTALLED (target) version so it fires once per upgrade, and
 * is written at attempt START (self-heal.ts) so a crash cannot retry-loop.
 *
 * Both versions are explicit parameters: `getSentinalVersion()` answers
 * differently in compiled vs source runs, so the caller decides.
 */

import type { MemoryStore } from "../memory/store.js";
import { logSidecar } from "../utils/file-log.js";

/** Notification `source` for skew signals. */
export const SKEW_NOTIFICATION_SOURCE = "sidecar-retire";

/** Minimal store surface (structural subset of SidecarContext). */
export interface SkewNotifyContext {
  store: Pick<MemoryStore, "getSetting" | "setSetting" | "insertNotification">;
}

/** Settings key guarding the skew signal for one installed version. */
export function skewNotifiedKey(installedVersion: string): string {
  return `sidecar_skew_notified_${installedVersion}`;
}

/**
 * Emit the skew signal at most once per installed version. Best-effort:
 * never throws. Returns true only when this call claimed the key and
 * attempted the signal; false when versions match, already notified, or the
 * store is unusable.
 */
export function notifySkewOnce(
  ctx: SkewNotifyContext,
  runningVersion: string,
  installedVersion: string,
): boolean {
  if (runningVersion === installedVersion) return false;

  const key = skewNotifiedKey(installedVersion);
  try {
    if (ctx.store.getSetting(key) !== null) return false;
    // Key at attempt START — a failure below must not re-fire every call.
    ctx.store.setSetting(key, String(Date.now()));
  } catch {
    return false; // no backoff protection → do not signal
  }

  const message =
    `The running sidecar is v${runningVersion} but the installed binary is ` +
    `v${installedVersion}. Run \`sentinal sidecar restart\` to align.`;

  logSidecar(`sidecar: version skew — ${message}`);

  try {
    ctx.store.insertNotification({
      type: "warning",
      title: `Sentinal sidecar outdated (v${runningVersion} → v${installedVersion})`,
      message,
      source: SKEW_NOTIFICATION_SOURCE,
      specId: null, // real FK to specs(id) — must stay null
    });
  } catch {
    // best-effort — the log line above already reached `sidecar logs`
  }
  return true;
}
