/**
 * TDD Project Notify — once-per-day "outdated client" signal (D4 of
 * docs/plans/2026-09-28-deferred-items.md).
 *
 * `POST /tdd-state {action:"set"}` without a `projectPath` is a hard 400.
 * Every current caller sends one (the OpenCode plugin, `tdd_set_state` since
 * v1.38.0); only a ≤1.37.1 client omits it — and that client swallows the
 * error, so without this signal its TDD tracking would silently stop.
 *
 * Shape mirrors `notifySkewOnce` (retire-notify.ts): check a settings key →
 * set it → notify. The key stores the local calendar DAY, so the notice fires
 * at most once per day. NULL project: the offending client names none, so it
 * is global — its source is on `GLOBAL_NOTIFICATION_SOURCES`.
 *
 * ⛔ Keep free of `bun:sqlite` (type-only store import): the session digest,
 * bundled into the OpenCode plugin, imports the source constant from here.
 */

import type { MemoryStore } from "../memory/store.js";

/** Notification `source` for the outdated-client TDD signal. */
export const TDD_MISSING_PROJECT_SOURCE = "tdd-missing-project";

/** Settings key holding the day (`YYYY-MM-DD`, local) of the last notice. */
export const TDD_MISSING_PROJECT_SETTING = "tdd_missing_project_notified_day";

/** Minimal store surface (structural subset of SidecarContext). */
export interface TddProjectNotifyContext {
  store: Pick<MemoryStore, "getSetting" | "setSetting" | "insertNotification">;
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Emit the notice at most once per calendar day. Best-effort: never throws.
 * Returns true only when this call claimed the day and attempted the insert.
 */
export function notifyMissingTddProjectOnce(
  ctx: TddProjectNotifyContext,
  now: Date = new Date(),
): boolean {
  const day = localDay(now);
  try {
    if (ctx.store.getSetting(TDD_MISSING_PROJECT_SETTING) === day) return false;
    // Claim the day BEFORE inserting — a failing insert must not re-fire.
    ctx.store.setSetting(TDD_MISSING_PROJECT_SETTING, day);
  } catch {
    return false;
  }

  try {
    ctx.store.insertNotification({
      type: "warning",
      title:
        "Outdated Sentinal client (≤1.37.1) tried to record TDD state without a project",
      message:
        "The sidecar rejected it, so TDD tracking in that session is not " +
        "recorded. Run `sentinal update`, then `sentinal sidecar restart`, " +
        "and start new Claude Code / OpenCode sessions.",
      source: TDD_MISSING_PROJECT_SOURCE,
      specId: null, // real FK to specs(id) — must stay null
    });
  } catch {
    // best-effort — the route's sidecar.log line still records the rejection
  }
  return true;
}
