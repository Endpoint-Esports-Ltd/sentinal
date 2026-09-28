/**
 * Real, read-only process probes behind `ownership.ts`: command line, cwd,
 * process-group enumeration, plus the pure path helpers ownership compares
 * with.
 *
 * ⛔ **Nothing in this file signals a process** — not even `kill(pid, 0)`
 * (that liveness probe stays in `ownership.ts`). `ownership.ts` remains the
 * single gate in front of every signal Sentinal sends; this module only
 * answers questions, and every failure answers `null` ("unproven"), which
 * `ownership.ts` reads as a refusal. Split out purely for length.
 */

import { sep } from "node:path";

export function realCommandOf(pid: number): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (r.stdout?.toString() ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * cwd of `pid`. `/proc` on Linux, `lsof` on macOS/BSD. Anything unexpected —
 * including Windows, which has neither — yields `null`, i.e. "unproven".
 */
export function realCwdOf(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      // Lazily required to keep this file free of a top-level fs dependency.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: keeps the ownership probes free of a top-level fs dependency (Linux-only branch)
      const { readlinkSync } = require("node:fs") as typeof import("node:fs");
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const r = Bun.spawnSync(
      ["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { stdout: "pipe", stderr: "ignore" },
    );
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      if (line.startsWith("n")) return line.slice(1).trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** `child` is `root` itself or lives underneath it. Prefix-safe. */
export function isUnder(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The symlink-resolved form of `path`, or `path` itself when unresolvable.
 *
 * ⚠️ Not cosmetic. On macOS `/var` is a symlink to `/private/var`, so a worktree
 * under `$TMPDIR` is handed to us as `/var/folders/…` while `lsof` reports the
 * process's cwd as `/private/var/folders/…`. Comparing literally makes ownership
 * **unprovable**, and unprovable means refuse — so `runtime_stop` would decline
 * to stop a process it demonstrably started. This widens nothing: the two
 * strings name the same directory.
 */
export function realpathOrSelf(path: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: keeps the ownership probes free of a top-level fs dependency (see realCwdOf)
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * PIDs whose process group is exactly `pgid`, or `null` when `ps` could not be
 * made to answer.
 *
 * ⚠️ **`ps -o pid= -g <pgid>` is NOT portable process-group selection**, which
 * is why this enumerates everything and filters. **Darwin** `ps(1)` documents
 * `-g` as _"Ignored; for compatibility with earlier versions of ps"_ — it
 * degrades to a bare `ps -o pid=` (the user's controlling-terminal processes).
 * **Linux/procps** reads `-g grplist` as a **session** id, not a pgid; since
 * `spawnDetached` uses `setsid()` that returns a superset, which is benign but
 * means the verification witness may come from a different group than the one
 * about to be signalled. `ps -A -o pid=,pgid=` is exact on both.
 */
export function realListGroup(pgid: number): number[] | null {
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    const pids: number[] = [];
    let parsedAnyRow = false;
    for (const line of (r.stdout?.toString() ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      parsedAnyRow = true;
      const pid = Number(m[1]);
      if (Number(m[2]) === pgid && Number.isInteger(pid) && pid > 1) {
        pids.push(pid);
      }
    }
    // `ps -A` always lists at least this process. Zero parsable rows means the
    // output shape was not what we expected — that is "unknown", not "empty".
    return parsedAnyRow ? pids : null;
  } catch {
    return null;
  }
}
