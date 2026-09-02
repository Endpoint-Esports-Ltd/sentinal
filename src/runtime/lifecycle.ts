/**
 * The D12 runtime lifecycle — preflight, start, and stop.
 *
 * ## ⛔ An occupied port is a HARD FAILURE. Never improvise a different port.
 *
 * This is the single rule the whole module is arranged around. Issue #2 is a
 * verification run that hit a bound port, moved to another one, and then
 * `pkill`-ed to clean up — and the guidance being replaced
 * (`spec-verify.md:236`) implicitly authorised the first half of that. A free
 * port proves nothing about what is behind it: the run then talks to a
 * different stack than the one it was supposed to verify, or to nothing at all.
 * There is no `+1`, no `findFreePort`, no retry-with-another-port anywhere in
 * this file, and `lifecycle.test.ts` asserts that the contract's `up` string is
 * spawned verbatim.
 *
 * ## Why the pidfile makes this better than the prior art
 *
 * Playwright's `reuseExistingServer: !process.env.CI` decides whether to adopt a
 * listener from an environment variable — it cannot tell *whose* process holds
 * the port. The pidfile can, so the matrix below distinguishes "our ready
 * stack" (reuse), "our interrupted startup" (recover), "our dead leader's
 * orphaned group" (reap, with verification), and "somebody else's process"
 * (refuse) — four outcomes where `reuseExistingServer` has two.
 *
 * ## The preflight matrix
 *
 * | Pidfile state                                  | Action                                              |
 * | ---------------------------------------------- | --------------------------------------------------- |
 * | `ready`, alive, ours                           | **Reuse** — and flag it, so teardown leaves it alone |
 * | `starting`, alive, ours                        | Interrupted `runtime_up` → tear down, spawn fresh    |
 * | alive, NOT provably ours                       | **Fail** — foreign process                           |
 * | unreadable                                     | **Fail** — guessing about a kill target is the bug   |
 * | leader dead, recorded port still bound         | Orphan → ownership-verified group reap, then re-probe |
 * | leader dead, port free                         | Delete the record, spawn                             |
 * | no pidfile, port bound                         | **Fail loudly.** Never re-port                       |
 *
 * ## A reused stack is NEVER torn down
 *
 * Killing a stack we did not start is the same class of error as `pkill -f`.
 * The `reused` flag exists so the caller cannot accidentally do it.
 */

import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./loader.js";
import { writePidfile, markPidfileReady } from "./pidfile.js";
import {
  spawnDetached,
  readLogTail,
  type SpawnDetachedResult,
} from "./spawn.js";
import {
  awaitReadiness,
  type AwaitReadinessOptions,
  type ReadinessResult,
} from "./readiness.js";
import { stopOwnedGroup, type StopResult } from "./teardown.js";
import { preflight } from "./preflight.js";
import type { GroupProbes } from "./ownership.js";
import type { StartTimeProbes } from "./proc-start.js";

// The preflight — every dangerous decision in this phase — lives in its own
// module. Re-exported so callers have a single entry point for the lifecycle.
export {
  readinessPort,
  readinessEndpoint,
  isPortBound,
  OCCUPIED_PORT_RULE,
} from "./preflight.js";
export type { Preflight, PreflightDeps } from "./preflight.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RuntimeUpResult {
  ok: boolean;
  /** False when the project has no `.sentinal/runtime.json` at all. */
  configured: boolean;
  /** True when THIS call spawned something. */
  started: boolean;
  /**
   * True when an already-running stack was adopted.
   * ⛔ A `reused` stack must NEVER be torn down by the caller.
   */
  reused: boolean;
  pid?: number;
  pgid?: number | null;
  /** What was done, in order — for the human/LLM reading the tool output. */
  actions: string[];
  warnings: string[];
  /** Present exactly when `ok` is false. */
  reason?: string;
  /** Attached to every failure after a spawn. Blind agents improvise. */
  logTail?: string;
}

/** Everything injectable, so each matrix row can be staged on demand. */
export interface RuntimeUpDeps {
  loadConfig?: (projectPath: string) => LoadedRuntimeConfig;
  spawn?: (opts: {
    worktreePath: string;
    command: string;
    slot?: number | null;
  }) => SpawnDetachedResult;
  awaitReady?: (opts: AwaitReadinessOptions) => Promise<ReadinessResult>;
  stop?: (projectPath: string) => Promise<StopResult>;
  /** True when something is already listening on `host:port`. */
  isPortBound?: (port: number, host?: string) => Promise<boolean>;
  probes?: GroupProbes & StartTimeProbes;
  logTail?: (projectPath: string) => string;
}

export interface RuntimeStopDeps {
  probes?: GroupProbes & StartTimeProbes;
  stop?: (projectPath: string) => Promise<StopResult>;
}

// ─── Failure helper ─────────────────────────────────────────────────────────

function fail(
  reason: string,
  over: Partial<RuntimeUpResult> = {},
): RuntimeUpResult {
  return {
    ok: false,
    configured: true,
    started: false,
    reused: false,
    actions: [],
    warnings: [],
    reason,
    ...over,
  };
}

// ─── up ─────────────────────────────────────────────────────────────────────

/**
 * Start the contract's `up` in a process group Sentinal owns, and return only
 * once the readiness probe passes.
 *
 * ⛔ Never throws. Every caller is an MCP tool or an exit path, and an exception
 * out of here is a stack trace where an actionable message was needed.
 */
export async function runtimeUp(
  projectPath: string,
  deps: RuntimeUpDeps = {},
): Promise<RuntimeUpResult> {
  const load = deps.loadConfig ?? loadRuntimeConfig;
  const spawn = deps.spawn ?? spawnDetached;
  const ready = deps.awaitReady ?? awaitReadiness;
  const stop =
    deps.stop ?? ((p: string) => stopOwnedGroup(p, { probes: deps.probes }));
  const tail = deps.logTail ?? readLogTail;

  let loaded: LoadedRuntimeConfig;
  try {
    loaded = load(projectPath);
  } catch (err) {
    return fail(
      `Could not read the runtime contract: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Inert: no contract at all. NOT an error — a project that never adopted
  // the contract must behave exactly as it did before it existed.
  if (!loaded.configured) {
    return {
      ok: true,
      configured: false,
      started: false,
      reused: false,
      warnings: loaded.warnings,
      actions: [
        `No ${loaded.relPath} in ${projectPath}. Nothing was started — start and stop the ` +
          `project however you normally would, or run \`runtime_init\` to draft a contract.`,
      ],
    };
  }

  if (loaded.error || !loaded.config) {
    return fail(loaded.error ?? "the runtime contract could not be parsed", {
      warnings: loaded.warnings,
    });
  }

  const config = loaded.config;
  if (!config.up) {
    return {
      ok: true,
      configured: true,
      started: false,
      reused: false,
      warnings: loaded.warnings,
      actions: [
        `${loaded.relPath} declares no \`up\` command, so there is nothing for Sentinal to start.`,
      ],
    };
  }

  const pre = await preflight(projectPath, config, deps);
  if (pre.kind === "fail") {
    return fail(pre.reason, {
      actions: pre.actions,
      warnings: loaded.warnings,
    });
  }
  if (pre.kind === "reuse") {
    return {
      ok: true,
      configured: true,
      started: false,
      reused: true,
      pid: pre.pid,
      pgid: pre.pgid,
      actions: pre.actions,
      warnings: loaded.warnings,
    };
  }

  // ── Spawn ────────────────────────────────────────────────────────────────
  let spawned: SpawnDetachedResult;
  try {
    spawned = spawn({
      worktreePath: projectPath,
      command: config.up,
      slot: loaded.slot,
    });
  } catch (err) {
    return fail(
      `Could not start \`${config.up}\`: ${err instanceof Error ? err.message : String(err)}`,
      { actions: pre.actions, warnings: loaded.warnings },
    );
  }

  // ⛔ IMMEDIATELY, before the first poll. See RUNTIME_PIDFILE_RELATIVE_PATH.
  const written = writePidfile(projectPath, {
    pid: spawned.pid,
    pgid: spawned.pgid,
    startedAt: Date.now(),
    command: spawned.command,
    state: "starting",
  });
  const warnings = [...loaded.warnings, ...written.warnings];
  const actions = [
    ...pre.actions,
    `Started \`${config.up}\` detached (pid ${spawned.pid}, process group ` +
      `${spawned.pgid ?? "none on this platform"}); recorded it in ${written.path} as state=starting.`,
  ];

  // ── Readiness ────────────────────────────────────────────────────────────
  const probe = await ready({
    probe: config.readiness!,
    cwd: projectPath,
    // Without this a crashed `up` burns the whole budget, and a ZERO-exit
    // detaching starter (`docker compose up -d`) cannot be told from a crash.
    leaderExitCode: () => spawned.exitCode(),
  });

  if (probe.ready) {
    const marked = markPidfileReady(projectPath, spawned.pid);
    if (!marked.ok && marked.reason) warnings.push(marked.reason);
    actions.push(
      `Readiness ${config.readiness!.type} probe \`${config.readiness!.target}\` passed after ` +
        `${probe.attempts} attempt(s) / ${probe.elapsedMs}ms` +
        (probe.detachingStarter
          ? ` (the \`up\` command exited 0 and was treated as a detaching starter)`
          : ``) +
        `.`,
    );
    return {
      ok: true,
      configured: true,
      started: true,
      reused: false,
      pid: spawned.pid,
      pgid: spawned.pgid,
      actions,
      warnings,
    };
  }

  // ⛔ A partial start still started things. Compensating teardown is mandatory
  // (`ExecStopPost` / `defer Terminate()`), and it runs BEFORE we report.
  const torn = await stop(projectPath);
  actions.push(...torn.actions);
  warnings.push(...torn.warnings);
  if (!torn.ok && torn.reason) warnings.push(torn.reason);

  return fail(probe.reason ?? "the readiness probe never passed", {
    actions,
    warnings,
    pid: spawned.pid,
    pgid: spawned.pgid,
    logTail: tail(projectPath),
  });
}

// ─── stop ───────────────────────────────────────────────────────────────────

/**
 * Terminate the process group recorded for `projectPath` — and nothing else.
 *
 * A thin, honest wrapper: every ownership decision belongs to
 * {@link stopOwnedGroup}, which refuses to signal anything it cannot prove.
 * Idempotent, and a fast no-op when no pidfile exists.
 */
export async function runtimeStop(
  projectPath: string,
  deps: RuntimeStopDeps = {},
): Promise<StopResult> {
  const stop =
    deps.stop ?? ((p: string) => stopOwnedGroup(p, { probes: deps.probes }));
  return stop(projectPath);
}
