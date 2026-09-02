/**
 * The D12 preflight — the decision in front of every `runtime_up`, made
 * WITHOUT doing any of it.
 *
 * ## ⛔ An occupied port is a HARD FAILURE. Never improvise a different port.
 *
 * This is the single rule the module is arranged around. Issue #2 is a
 * verification run that hit a bound port, moved to another one, and then
 * `pkill`-ed to clean up — and the guidance being replaced
 * (`spec-verify.md:236`) implicitly authorised the first half of that. A free
 * port proves nothing about what is behind it: the run then verifies a
 * different stack than the one under test, or nothing at all. There is no `+1`,
 * no `findFreePort`, no retry-with-another-port anywhere in this file.
 *
 * ## Why the pidfile beats the prior art
 *
 * Playwright's `reuseExistingServer: !process.env.CI` decides whether to adopt
 * a listener from an environment variable — it cannot tell *whose* process
 * holds the port. The pidfile can, so the matrix below distinguishes "our ready
 * stack" (reuse), "our interrupted startup" (recover), "our dead leader's
 * orphaned group" (reap, ownership-verified) and "somebody else's process"
 * (refuse) — four outcomes where `reuseExistingServer` has two.
 *
 * | Pidfile state                          | Action                                              |
 * | -------------------------------------- | --------------------------------------------------- |
 * | `ready`, alive, ours                   | **Reuse** — flagged, so teardown leaves it alone     |
 * | `starting`, alive, ours                | Interrupted `runtime_up` → tear down, spawn fresh    |
 * | alive, NOT provably ours               | **Fail** — foreign process                           |
 * | unreadable                             | **Fail** — guessing about a kill target IS the bug   |
 * | leader dead, port bound OR group still enumerable-and-live | Orphan → ownership-verified group reap, then re-probe |
 * | leader dead, port free AND group enumerated as empty | Delete the record, spawn                  |
 * | leader dead, group NOT enumerable      | Reap is attempted and REFUSES; record kept          |
 * | no pidfile, port bound                 | **Fail loudly.** Never re-port                       |
 *
 * ⛔ Split out of `lifecycle.ts` (which was 515 lines) rather than inlined: a
 * decision function that also spawns is a decision function nobody can test
 * exhaustively, and every dangerous decision in this phase is made here.
 */

import { createServer, createConnection } from "node:net";
import { inspectPidfile, removePidfile } from "./pidfile.js";
import { resolveExistingClaim } from "./pidfile-claim.js";
import { stopOwnedGroup, type StopResult } from "./teardown.js";
import {
  listGroupMembers,
  type GroupProbes,
  type GroupProbeResult,
} from "./ownership.js";
import type { StartTimeProbes } from "./proc-start.js";
import type { RuntimeConfig } from "./schema.js";

/** What {@link preflight} needs from its caller, all injectable. */
export interface PreflightDeps {
  stop?: (projectPath: string) => Promise<StopResult>;
  /** True when something is already listening on `host:port`. */
  isPortBound?: (port: number, host?: string) => Promise<boolean>;
  probes?: GroupProbes & StartTimeProbes;
}

export type Preflight =
  | { kind: "spawn"; actions: string[] }
  | { kind: "reuse"; pid: number; pgid: number | null; actions: string[] }
  | { kind: "fail"; reason: string; actions: string[] };

// ─── Port ───────────────────────────────────────────────────────────────────

/**
 * The port an `http` readiness probe targets, or `null` when there is none.
 *
 * ⛔ This is the ONLY place a port is derived, and it is derived from the
 * project's own declared probe. Nothing here invents, increments or searches
 * for a port.
 */
export function readinessPort(config: RuntimeConfig): number | null {
  return readinessEndpoint(config)?.port ?? null;
}

/**
 * The host **and** port an `http` probe targets.
 *
 * The host matters: probing `127.0.0.1` for a contract that declares
 * `http://localhost:3000` is usually the same thing and occasionally is not
 * (IPv6-only `localhost`), and a wrong answer here is either a spurious
 * hard-failure or a missed occupied port.
 */
export function readinessEndpoint(
  config: RuntimeConfig,
): { host: string; port: number } | null {
  const r = config.readiness;
  if (!r || r.type !== "http") return null;
  try {
    const url = new URL(r.target);
    const host = url.hostname || "127.0.0.1";
    if (url.port) return { host, port: Number(url.port) };
    if (url.protocol === "https:") return { host, port: 443 };
    if (url.protocol === "http:") return { host, port: 80 };
    return null;
  } catch {
    return null;
  }
}

/** Can we open a TCP connection to `host:port`? A `true` is definitive. */
function canConnect(port: number, host: string, timeoutMs = 300) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const sock = createConnection({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Does binding `host:port` fail because someone already holds it? */
function bindRefused(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      try {
        srv.close();
      } catch {
        /* never listened */
      }
      // EACCES (a privileged port) is "we cannot have it either" — same answer.
      resolve(code === "EADDRINUSE" || code === "EACCES");
    });
    srv.once("listening", () => srv.close(() => resolve(false)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Is `port` already taken?
 *
 * ⚠️ **Both probes are needed, and a bind probe alone is WRONG on macOS.**
 * Measured, not assumed: a `Bun.serve` listening on `0.0.0.0:P` does **not**
 * prevent a subsequent `listen(P, "127.0.0.1")` on Darwin, because BSD's
 * `SO_REUSEADDR` (which Node sets by default) permits binding a more-specific
 * address over a wildcard one. A bind-only probe therefore reports "free" for a
 * port that is very much in use — and the resulting `runtime_up` proceeds, the
 * project's own `up` crashes with `EADDRINUSE`, and the agent is left staring
 * at exactly the situation issue #2 says it will improvise its way out of.
 *
 * So: connect first (a successful connection is proof), then fall back to the
 * bind probe, which still catches a listener that accepts nothing and a
 * privileged port we could not take anyway.
 */
export async function isPortBound(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  if (await canConnect(port, host)) return true;
  return bindRefused(port, host);
}

// ─── The rule ───────────────────────────────────────────────────────────────

/**
 * ⛔ Every occupied-port failure message carries this verbatim.
 *
 * Omitting the improvisation is not the same as forbidding it. The guidance
 * this phase replaces said nothing either way, and an agent facing a bound port
 * with no instruction picks another one — which is step 2 of the incident.
 */
export const OCCUPIED_PORT_RULE =
  "⛔ Do NOT start this on another port. A free port proves nothing about what is behind it — " +
  "the run would then verify a different stack than the one under test, which is exactly the " +
  "incident this contract exists to prevent. Identify and stop whatever holds the port, or fix " +
  "the `up`/`readiness` declaration in .sentinal/runtime.json.";

/**
 * Decide what `up` should do, without doing any of it.
 *
 * ⛔ Never throws, and never signals anything itself — the one place it can
 * reach a process group is {@link stopOwnedGroup}, which refuses without
 * ownership proof.
 */
export async function preflight(
  projectPath: string,
  config: RuntimeConfig,
  deps: PreflightDeps,
): Promise<Preflight> {
  const stop =
    deps.stop ?? ((p: string) => stopOwnedGroup(p, { probes: deps.probes }));
  const portBound = deps.isPortBound ?? isPortBound;
  const endpoint = readinessEndpoint(config);
  const port = endpoint?.port ?? null;
  const actions: string[] = [];

  const bound = async (): Promise<boolean> =>
    endpoint === null ? false : await portBound(endpoint.port, endpoint.host);

  // ── M4c: a `claiming` record is another runtime_up's exclusive claim ──────
  // It must be resolved BEFORE the matrix: its pid is the claiming
  // orchestrator, not a spawned leader, so the generic verdict machinery would
  // misread it (H5 reports `stale` and the stale row would DELETE a live
  // claim, reopening the race the claim exists to close).
  const claim = resolveExistingClaim(projectPath, deps.probes ?? {});
  if (claim.kind === "held") {
    return { kind: "fail", actions, reason: claim.reason };
  }
  if (claim.kind === "released") actions.push(claim.action);

  const verdict = inspectPidfile(projectPath, deps.probes ?? {});

  switch (verdict.kind) {
    case "owned": {
      if (verdict.entry.state === "ready") {
        return {
          kind: "reuse",
          pid: verdict.entry.pid,
          pgid: verdict.entry.pgid,
          actions: [
            `Reusing the stack already running for this worktree (pid ${verdict.entry.pid}, ` +
              `process group ${verdict.entry.pgid ?? "unknown"}). ⛔ It was NOT started by this ` +
              `call and must NOT be torn down by it.`,
          ],
        };
      }
      // `state=starting` and alive: either an interrupted runtime_up — or a
      // CONCURRENT one still inside its readiness poll (M4c). The record's
      // age decides: a `starting` record younger than the startup budget is
      // presumed in-progress, and tearing it down would BE the race (the
      // claim loser "recovering" the winner's seconds-old stack). `startedAt`
      // is trustworthy here — `owned` verdicts have passed the H5 start-time
      // check against it.
      const budgetMs = config.readiness?.startupTimeoutMs ?? 60000;
      const ageMs = Date.now() - verdict.entry.startedAt;
      if (ageMs <= budgetMs) {
        return {
          kind: "fail",
          actions,
          reason:
            `Another runtime_up appears to be starting this worktree RIGHT NOW: pid ` +
            `${verdict.entry.pid} was recorded ${Math.round(ageMs / 1000)}s ago (state=starting) ` +
            `and its startup budget (${budgetMs}ms) has not elapsed. NOT tearing it down. ` +
            `Retry shortly — the record will flip to "ready" (and be reused) or go stale.`,
        };
      }
      // Older than the budget: a previous runtime_up was interrupted
      // mid-startup. That group is ours, so tearing it down is safe — and
      // leaving it would race the stack we are about to spawn.
      const r = await stop(projectPath);
      actions.push(
        `Found an interrupted startup (pid ${verdict.entry.pid}, state=starting) and tore it down.`,
        ...r.actions,
      );
      if (!r.ok) {
        return {
          kind: "fail",
          actions,
          reason:
            `An interrupted \`runtime_up\` left a live process group that could not be stopped: ` +
            `${r.reason} Not spawning on top of it.`,
        };
      }
      if (await bound()) {
        return {
          kind: "fail",
          actions,
          reason:
            `Port ${port} is still bound after tearing down the interrupted startup ` +
            `(process group ${verdict.entry.pgid ?? "unknown"}). ${OCCUPIED_PORT_RULE}`,
        };
      }
      return { kind: "spawn", actions };
    }

    case "foreign":
      return {
        kind: "fail",
        actions,
        reason:
          `${verdict.reason} Not starting anything, and not signalling it either. Remedy: confirm ` +
          `by hand what pid ${verdict.entry.pid} is, then delete .sentinal/runtime.pid.`,
      };

    case "unreadable":
      return { kind: "fail", actions, reason: verdict.reason };

    case "stale": {
      // The recorded leader is dead. That does NOT mean the stack is: a shell
      // wrapper without `exec` dies while its children outlive it, which is the
      // routine shape of `npm run dev`.
      const portIsBound = await bound();

      // ⛔ Two independent questions, and the record may only be discarded when
      // BOTH answer "nothing here".
      //
      // The port probe alone is not enough: `bound()` is hard-coded `false`
      // whenever the contract declares no `http` readiness probe (every `exec`
      // probe, and any http target whose port cannot be derived), so for those
      // contracts the port test degenerates into "always free" and this row
      // would delete the ownership record of a live group unconditionally. The
      // group-member probe is the question that CAN be asked of every contract.
      const groupProbe: GroupProbeResult =
        verdict.entry.pgid === null
          ? { kind: "members", members: [] }
          : listGroupMembers(verdict.entry.pgid, deps.probes ?? {});
      const groupIsGone =
        groupProbe.kind === "members" && groupProbe.members.length === 0;

      if (!portIsBound && groupIsGone) {
        removePidfile(projectPath, verdict.entry.pid);
        actions.push(
          `Removed a stale ownership record (pid ${verdict.entry.pid} is gone, process group ` +
            `${verdict.entry.pgid ?? "unknown"} has no live members, and ` +
            (port === null
              ? `the contract declares no http probe, so there is no port to re-check`
              : `port ${port} is free`) +
            `).`,
        );
        return { kind: "spawn", actions };
      }

      // ⛔ Orphan reap. The leader is dead, so leader-PID verification is
      // structurally IMPOSSIBLE — and PGIDs are drawn from the same wrapping
      // space as PIDs, so this pgid may already belong to a stranger.
      // `stopOwnedGroup` runs the same `maySignalGroup` gate, which requires a
      // live group member whose command line or cwd references this worktree
      // and REFUSES outright when none does — including when the group could
      // not be enumerated at all.
      const blocker = portIsBound
        ? `Port ${port} is held by an orphaned process group from a previous run`
        : `The recorded leader (pid ${verdict.entry.pid}) is dead but its process group ` +
          `${verdict.entry.pgid ?? "unknown"} could not be ruled out as live`;
      const r = await stop(projectPath);
      actions.push(...r.actions);
      if (!r.ok) {
        return {
          kind: "fail",
          actions,
          reason:
            `${blocker}, and it could not be safely reclaimed: ${r.reason} Not spawning on top ` +
            `of it, and the ownership record has been left in place.` +
            (portIsBound ? ` ${OCCUPIED_PORT_RULE}` : ""),
        };
      }
      if (await bound()) {
        return {
          kind: "fail",
          actions,
          reason:
            `Port ${port} is STILL bound after signalling process group ` +
            `${verdict.entry.pgid ?? "unknown"}, so whatever holds it is not in that group. ` +
            `${OCCUPIED_PORT_RULE}`,
        };
      }
      actions.push(
        `Reaped the orphaned process group ${verdict.entry.pgid ?? "unknown"} left by a dead ` +
          `leader` +
          (port === null ? `.` : `; port ${port} is free again.`),
      );
      return { kind: "spawn", actions };
    }

    case "absent": {
      if (await bound()) {
        return {
          kind: "fail",
          actions,
          reason:
            `Port ${port} is already in use, and there is NO .sentinal/runtime.pid — so Sentinal ` +
            `did not start whatever holds it and has no way to identify or own it. ` +
            `${OCCUPIED_PORT_RULE}`,
        };
      }
      return { kind: "spawn", actions };
    }
  }
}
