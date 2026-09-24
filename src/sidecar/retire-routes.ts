/**
 * Retire Routes — POST /retire + the shared retire-request helpers
 *
 * Two producers converge on ONE flag (`ctx.retire`):
 *   - a client that detected version skew (POST /retire), and
 *   - the sidecar's own binary-staleness poll (createStalenessTick).
 *
 * D3: neither producer shuts anything down. They only SET the flag; the
 * session-aware shutdown interval (server.ts) owns the "when safe" decision
 * and applies the normal grace period (D2). The route returns immediately
 * and is idempotent — the FIRST request's reason/time are kept.
 *
 * D4: retire is STOP-ONLY. Nothing here respawns a sidecar.
 *
 * Lives outside routes.ts, which is at its length budget.
 */

import type { SidecarContext } from "./server.js";
import type { BinaryStalenessChecker } from "./retire-check.js";
import { notifySkewOnce } from "./retire-notify.js";
import { ok } from "./response.js";
import { logSidecar } from "../utils/file-log.js";

/** Set on SidecarContext once a retire has been requested. Never cleared. */
export interface RetireRequest {
  reason: string;
  requestedAt: number;
}

export interface SkewVersions {
  runningVersion: string;
  installedVersion: string;
}

/**
 * Request retirement. Sets `ctx.retire` if unset (returns true only for the
 * call that set it) and, when both versions are known, emits the
 * once-per-installed-version skew signal. Never throws.
 */
export function requestRetire(
  ctx: SidecarContext,
  reason: string,
  versions?: SkewVersions,
): boolean {
  let first = false;
  if (!ctx.retire) {
    ctx.retire = { reason, requestedAt: Date.now() };
    first = true;
    logSidecar(`sidecar: retire requested (${reason}) — will stop when idle`);
  }
  if (versions) {
    try {
      notifySkewOnce(ctx, versions.runningVersion, versions.installedVersion);
    } catch {
      /* best-effort — notifySkewOnce already swallows, belt and braces */
    }
  }
  return first;
}

const MAX_VERSION_LEN = 64;

function versionField(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_VERSION_LEN
    ? v
    : null;
}

async function readVersions(req: Request): Promise<SkewVersions | undefined> {
  try {
    const body = (await req.json()) as Record<string, unknown> | null;
    const runningVersion = versionField(body?.runningVersion);
    const installedVersion = versionField(body?.installedVersion);
    return runningVersion && installedVersion
      ? { runningVersion, installedVersion }
      : undefined;
  } catch {
    return undefined; // empty / malformed body is still a valid retire request
  }
}

/** Handle POST /retire. Returns null for any other request. */
export async function handleRetireRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/retire" || req.method !== "POST") return null;

  const versions = await readVersions(req);
  const alreadyRequested = !requestRetire(ctx, "client request", versions);
  return ok({ retiring: true, alreadyRequested });
}

/**
 * Build a SYNC tick for the shutdown interval that polls the staleness
 * checker fire-and-forget. At most one check is in flight — a slow
 * `--version` probe cannot stack up across ticks. On a stale result the
 * flag is set and the skew signal emitted.
 */
export function createStalenessTick(
  ctx: SidecarContext,
  checker: BinaryStalenessChecker,
): () => void {
  let pending = false;
  return () => {
    if (pending || ctx.retire || !checker.active) return;
    pending = true;
    checker
      .check()
      .then((r) => {
        if (!r.stale || !r.installedVersion) return;
        requestRetire(ctx, `installed binary is v${r.installedVersion}`, {
          runningVersion: r.runningVersion,
          installedVersion: r.installedVersion,
        });
      })
      .catch(() => {
        /* check() never rejects; defensive */
      })
      .finally(() => {
        pending = false;
      });
  };
}
