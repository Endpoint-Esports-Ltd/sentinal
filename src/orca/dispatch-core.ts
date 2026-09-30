/**
 * Helpers every Orca dispatch mutation shares (split from `dispatch-start.ts`
 * for length; `dispatch-start.ts` re-exports them).
 */

import { randomUUID } from "node:crypto";
import { runOrca, type OrcaError, type OrcaRunner } from "./cli.js";

export type Failure = { ok: false; error: OrcaError; requestId?: string };
export type Ok<T> = { ok: true } & T;

export interface Base {
  runner?: OrcaRunner;
  /** Replay a mutation whose response was lost; default a fresh UUID. */
  requestId?: string;
}

export const err = (
  code: string,
  message: string,
  requestId?: string,
): Failure => ({
  ok: false,
  error: { code, message },
  ...(requestId ? { requestId } : {}),
});

export async function mutate<T>(
  args: string[],
  o: Base & { timeoutMs?: number },
): Promise<{ ok: true; result: T; requestId: string } | Failure> {
  const requestId = o.requestId ?? randomUUID();
  const r = await runOrca<T>(
    ["orchestration", ...args, "--retry-request", requestId],
    { runner: o.runner, timeoutMs: o.timeoutMs },
  );
  return r.ok
    ? { ok: true, result: r.result, requestId }
    : { ok: false, error: r.error, requestId };
}

/** Orca worktree ids are `<repo-id>::<absolute path>`. */
export const pathFromId = (id?: string): string | undefined => {
  const i = id ? id.indexOf("::") : -1;
  return id && i !== -1 ? id.slice(i + 2) : undefined;
};
