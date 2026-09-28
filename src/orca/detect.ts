/**
 * Is Orca usable as the orchestrator here (D6), and is a worker agent's login
 * healthy (D7 auth preflight)? Both go through `runOrca`, so they never throw.
 */

import { runOrca, type OrcaRunner } from "./cli.js";
import type {
  OrcaAccountListResult,
  OrcaRateLimitEntry,
  OrcaStatusResult,
} from "./types.js";

export const ORCA_CONTRACT_CAPABILITY = "orchestration.contract.v1";
const DETECT_TIMEOUT_MS = 5_000;

export type OrcaDetectReason =
  | "ready"
  | "no-terminal-handle"
  | "orca-unavailable"
  | "runtime-unreachable"
  | "runtime-not-ready"
  | "missing-capability";

export interface OrcaDetection {
  available: boolean;
  reason: OrcaDetectReason;
  /** One line saying why, suitable for "falling back to subagents: …". */
  detail: string;
  /** `ORCA_TERMINAL_HANDLE` — the coordinator's terminal — or null. */
  terminalHandle: string | null;
  appVersion: string | null;
  capabilities: string[];
}

export interface OrcaProbeOptions {
  env?: Record<string, string | undefined>;
  runner?: OrcaRunner;
  timeoutMs?: number;
}

export async function detectOrca(
  opts: OrcaProbeOptions = {},
): Promise<OrcaDetection> {
  const env = opts.env ?? process.env;
  const handle = env.ORCA_TERMINAL_HANDLE?.trim() || null;
  const base = { terminalHandle: handle, appVersion: null, capabilities: [] };
  if (!handle) {
    return {
      ...base,
      available: false,
      reason: "no-terminal-handle",
      detail:
        "ORCA_TERMINAL_HANDLE is not set: not running inside an Orca terminal",
    };
  }

  const r = await runOrca<OrcaStatusResult>(["status", "--json"], {
    runner: opts.runner,
    timeoutMs: opts.timeoutMs ?? DETECT_TIMEOUT_MS,
  });
  if (!r.ok) {
    return {
      ...base,
      available: false,
      reason: "orca-unavailable",
      detail: `orca status failed (${r.error.code}): ${r.error.message}`,
    };
  }

  const runtime = r.result?.runtime ?? {};
  const found = {
    ...base,
    appVersion:
      typeof runtime.appVersion === "string" ? runtime.appVersion : null,
    capabilities: Array.isArray(runtime.capabilities)
      ? runtime.capabilities.filter((c): c is string => typeof c === "string")
      : [],
  };
  if (runtime.reachable !== true) {
    return {
      ...found,
      available: false,
      reason: "runtime-unreachable",
      detail: "Orca runtime is not reachable",
    };
  }
  if (runtime.state !== "ready") {
    return {
      ...found,
      available: false,
      reason: "runtime-not-ready",
      detail: `Orca runtime state is ${String(runtime.state ?? "unknown")}, not ready`,
    };
  }
  if (!found.capabilities.includes(ORCA_CONTRACT_CAPABILITY)) {
    return {
      ...found,
      available: false,
      reason: "missing-capability",
      detail: `Orca ${found.appVersion ?? "(unknown version)"} lacks ${ORCA_CONTRACT_CAPABILITY}`,
    };
  }
  return {
    ...found,
    available: true,
    reason: "ready",
    detail: `Orca ${found.appVersion ?? ""} ready`.replace(/\s+/g, " ").trim(),
  };
}

/** Agents whose login Orca tracks in `account list`'s `rateLimits`. */
const ORCA_MANAGED_AGENTS = new Set(["claude", "codex"]);

export type AgentAuth =
  | {
      ok: true;
      agent: string;
      /** `unknown` = could not tell; the preflight fails open. */
      reason: "ok" | "not-managed-by-orca" | "unknown";
      status?: string;
      detail?: string;
    }
  | {
      ok: false;
      agent: string;
      /** `stale-token`, or Orca's `usageMetadata.failureKind` (e.g. `rate-limited`). */
      reason: "stale-token" | (string & {});
      status: string;
      detail: string;
      failureKind?: string;
      retryAtMs?: number;
    };

function asEntry(v: unknown): OrcaRateLimitEntry | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as OrcaRateLimitEntry)
    : null;
}

/**
 * Preflight a worker agent's login. `claude`/`codex` are refused when Orca
 * reports `status: "error"` or any `usageMetadata.failureKind`; every other
 * agent (e.g. `opencode`) is not tracked by Orca and passes as
 * `not-managed-by-orca`. Unreadable account data fails open (`unknown`).
 */
export async function agentAuth(
  agentId: string,
  opts: Omit<OrcaProbeOptions, "env"> = {},
): Promise<AgentAuth> {
  const agent = agentId.trim().toLowerCase();
  if (!ORCA_MANAGED_AGENTS.has(agent)) {
    return { ok: true, agent, reason: "not-managed-by-orca" };
  }

  const r = await runOrca<OrcaAccountListResult>(
    ["account", "list", "--json"],
    {
      runner: opts.runner,
      timeoutMs: opts.timeoutMs ?? DETECT_TIMEOUT_MS,
    },
  );
  if (!r.ok) {
    return {
      ok: true,
      agent,
      reason: "unknown",
      detail: `orca account list failed (${r.error.code}): ${r.error.message}`,
    };
  }
  const entry = asEntry(r.result?.rateLimits?.[agent]);
  if (!entry) {
    return {
      ok: true,
      agent,
      reason: "unknown",
      detail: `orca account list has no entry for ${agent}`,
    };
  }

  const status = typeof entry.status === "string" ? entry.status : "unknown";
  const failureKind =
    typeof entry.usageMetadata?.failureKind === "string"
      ? entry.usageMetadata.failureKind
      : undefined;
  if (status !== "error" && !failureKind) {
    return { ok: true, agent, reason: "ok", status };
  }

  const refused: AgentAuth = {
    ok: false,
    agent,
    reason: failureKind ?? "stale-token",
    status,
    detail:
      (typeof entry.error === "string" && entry.error) ||
      `${agent} login is not healthy (status ${status})`,
  };
  if (failureKind) refused.failureKind = failureKind;
  const retryAtMs = entry.usageMetadata?.retryAtMs;
  if (typeof retryAtMs === "number") refused.retryAtMs = retryAtMs;
  return refused;
}
