/**
 * Pre-warmed start (issue #13, docs/plans/2026-09-30-orca-prewarmed-start.md).
 *
 * Orca's `worker-start --agent` pastes the brief once the terminal accepts
 * bracketed paste (~0.8 s), but OpenCode draws its input box 3.3–6.6 s later
 * and discards anything pasted before that (OpenCode #42915, Orca #22580 /
 * #17741). So for listed agents Sentinal starts the agent itself, waits until
 * the input box is drawn, and only then runs `worker-start --terminal <h>` —
 * Orca's guide: "Use `worker-start --terminal <handle>` when lifecycle
 * ownership of an existing agent terminal is required".
 *
 * ⛔ `closeTerminal` is only ever called for a handle Sentinal created here.
 */

import { runOrca, type OrcaRunner } from "./cli.js";
import type { Placement } from "./dispatch-attempts.js";
import { showsHomeScreen } from "./stall-terminal.js";
import type {
  OrcaRequestShowResult,
  OrcaTerminalCreateResult,
  OrcaTerminalReadResult,
  OrcaTerminalWaitResult,
} from "./types.js";

export const DEFAULT_PREWARM_AGENTS = ["opencode"];
export const PREWARM_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const SLACK_MS = 1_000;
const MIN_CALL_MS = 1_000;

/** `SENTINAL_ORCA_PREWARM_AGENTS`: comma list; default opencode; `none` off. */
export function prewarmAgents(
  env: Record<string, string | undefined>,
): string[] {
  const raw = env.SENTINAL_ORCA_PREWARM_AGENTS;
  if (raw === undefined) return [...DEFAULT_PREWARM_AGENTS];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length === 1 && list[0]!.toLowerCase() === "none" ? [] : list;
}

/** Only into an existing worktree: `new-child` has no worktree yet. */
export function usePrewarm(
  agent: string,
  placement: Placement,
  agents: readonly string[],
): boolean {
  return placement !== "new-child" && agents.includes(agent);
}

export interface PrewarmClock {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: PrewarmClock = {
  clock: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type PrewarmResult =
  | { ok: true; handle: string; readyMs: number }
  | { ok: false; handle?: string; reason: string };

const worktreeSelector = (p: Placement): string =>
  typeof p === "object" ? `path:${p.path}` : "current";

/** Create the agent terminal and wait until its input box is drawn. Never throws. */
export async function prewarmTerminal(
  o: {
    placement: Placement;
    agent: string;
    /** The launch command (default: the bare agent). */
    command?: string;
    taskId: string;
    runner?: OrcaRunner;
    timeoutMs?: number;
    onCreated?: (handle: string) => void;
  } & Partial<PrewarmClock>,
): Promise<PrewarmResult> {
  const { clock, sleep } = { ...realClock, ...o };
  const start = clock();
  const deadline = start + (o.timeoutMs ?? PREWARM_TIMEOUT_MS);
  const left = () => Math.max(deadline - clock(), MIN_CALL_MS);

  const created = await runOrca<OrcaTerminalCreateResult>(
    [
      "terminal",
      "create",
      "--worktree",
      worktreeSelector(o.placement),
      "--command",
      o.command ?? o.agent,
      "--title",
      `worker-${o.taskId}`,
    ],
    { runner: o.runner },
  );
  const handle = created.ok ? created.result?.terminal?.handle : undefined;
  if (!created.ok || typeof handle !== "string") {
    return {
      ok: false,
      reason: `terminal create failed: ${created.ok ? "no handle" : created.error.message}`,
    };
  }
  o.onCreated?.(handle);

  const wait = await runOrca<OrcaTerminalWaitResult>(
    [
      "terminal",
      "wait",
      "--terminal",
      handle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      String(Math.round(left())),
    ],
    { runner: o.runner, timeoutMs: left() + 5_000 },
  );
  if (!wait.ok || wait.result?.wait?.satisfied !== true) {
    return { ok: false, handle, reason: "the agent's TUI never went idle" };
  }

  // tui-idle can fire before the input box mounts (Orca #17741): poll for it.
  for (;;) {
    const read = await runOrca<OrcaTerminalReadResult>(
      ["terminal", "read", "--terminal", handle, "--screen"],
      { runner: o.runner },
    );
    const tail = read.ok ? read.result?.terminal?.tail : undefined;
    if (Array.isArray(tail) && showsHomeScreen(tail)) break;
    if (clock() + POLL_MS > deadline) {
      return {
        ok: false,
        handle,
        reason: `the agent's input box never appeared within ${Math.round((o.timeoutMs ?? PREWARM_TIMEOUT_MS) / 1000)} s`,
      };
    }
    await sleep(POLL_MS);
  }
  await sleep(SLACK_MS);
  return { ok: true, handle, readyMs: Math.round(clock() - start) };
}

/** Close a terminal Sentinal created. Never throws. */
export async function closeTerminal(
  handle: string,
  runner?: OrcaRunner,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await runOrca(["terminal", "close", "--terminal", handle], {
    runner,
  });
  return r.ok ? { ok: true } : { ok: false, message: r.error.message };
}

/** `request-show`: did a mutation already take effect? Errors read as absent. */
export async function requestOutcome(
  requestId: string,
  runner?: OrcaRunner,
): Promise<OrcaRequestShowResult> {
  const r = await runOrca<OrcaRequestShowResult>(
    ["orchestration", "request-show", "--request", requestId],
    { runner },
  );
  return r.ok && r.result
    ? r.result
    : {
        requestId,
        state: "absent",
        interpretation: r.ok ? "no result" : r.error.message,
      };
}
