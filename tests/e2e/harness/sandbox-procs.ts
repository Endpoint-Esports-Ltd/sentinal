// Sandbox teardown: kill sandbox-owned processes, ownership-verified
// (split out of sandbox.ts). Import through ./sandbox.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeVariants } from "./real-escape.ts";

// ── Teardown: kill sandbox-owned processes (ownership-verified) ──────────────

// $SENTINAL_HOME pidfiles: sidecar = SIDECAR_PID_FILE (src/sidecar/paths.ts),
// dashboard = PID_FILE (src/dashboard/lifecycle.ts). SENTINAL_HOME is pinned
// to <sandbox>/.sentinal, so both live there.
const SANDBOX_PIDFILES = ["sidecar.pid", "server.pid"];

/** `KEY=value` env tokens only a process spawned from this sandbox carries. */
function ownershipTokens(home: string, id: string): Set<string> {
  const t = new Set([`SENTINAL_E2E_SANDBOX_ID=${id}`]);
  for (const h of homeVariants(home)) {
    t.add(`HOME=${h}`);
    t.add(`SENTINAL_HOME=${join(h, ".sentinal")}`);
  }
  return t;
}

// `ps eww` appends the environment to the command (macOS and Linux, for the
// user's own processes). Sandbox paths are only in the ENV — sidecar/dashboard
// command lines don't name them — so ownership is proven from the env.
function envOwned(line: string, tokens: Set<string>): boolean {
  return line.split(/\s+/).some((tok) => tokens.has(tok));
}

function processOwned(pid: number, tokens: Set<string>): boolean {
  const r = Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return envOwned(r.stdout?.toString() ?? "", tokens);
}

function scanOwned(tokens: Set<string>): number[] {
  const r = Bun.spawnSync(["ps", "axeww", "-o", "pid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: number[] = [];
  for (const line of (r.stdout?.toString() ?? "").split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    const pid = Number(m?.[1]);
    if (!m || pid <= 1 || pid === process.pid || pid === process.ppid) continue;
    if (envOwned(m[2] ?? "", tokens)) out.push(pid);
  }
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
  });
  const stat = r.stdout?.toString().trim() ?? "";
  return stat !== "" && !stat.startsWith("Z"); // a zombie is dead
}

function waitGone(pids: Iterable<number>, ms: number): void {
  const deadline = Date.now() + ms;
  while ([...pids].some(isAlive) && Date.now() < deadline) Bun.sleepSync(50);
}

/**
 * Kill every process owned by the sandbox: first those named in its own
 * pidfiles (only after proving the pid's env belongs to the sandbox — a
 * recycled pid or the user's real sidecar is never signalled), then strays
 * found by env match. SIGTERM → grace → SIGKILL. Returns survivors.
 */
export function killSandboxProcesses(
  sandboxHome: string,
  id: string,
  graceMs = 3000,
): number[] {
  const tokens = ownershipTokens(sandboxHome, id);
  const owned = new Set<number>();
  for (const file of SANDBOX_PIDFILES) {
    const pid = Number(safeRead(join(sandboxHome, ".sentinal", file)).trim());
    if (Number.isInteger(pid) && pid > 1 && processOwned(pid, tokens)) {
      owned.add(pid);
    }
  }
  for (const pid of scanOwned(tokens)) owned.add(pid);
  for (let round = 0; round < 2 && owned.size > 0; round++) {
    for (const pid of owned) trySignal(pid, "SIGTERM");
    waitGone(owned, graceMs);
    for (const pid of owned) if (isAlive(pid)) trySignal(pid, "SIGKILL");
    waitGone(owned, 2000);
    // Anything spawned while we were terminating (e.g. a respawned sidecar).
    const late = scanOwned(tokens).filter((p) => !owned.has(p));
    if (late.length === 0) break;
    for (const pid of late) owned.add(pid);
  }
  return [...owned].filter(isAlive);
}

function trySignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
