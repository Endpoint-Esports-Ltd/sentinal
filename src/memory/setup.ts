/**
 * Memory Setup — `sentinal memory setup`
 *
 * Provisions `~/.sentinal/deps` with `sqlite-vec` and `@xenova/transformers`
 * so compiled binaries (which cannot bundle native deps) get vector search.
 * Installs via `bun add` when available, falling back to
 * `npm install --prefix`. Versions are pinned to the root package.json.
 *
 * OS matrix: Linux x64/arm64 needs no prerequisites (system SQLite loads
 * extensions); macOS additionally needs Homebrew SQLite (`brew install
 * sqlite`); Windows is out of scope (no Windows release binaries).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEPS_DIR, nativeDepsStatus, SETUP_HINT } from "./native-deps.js";
import type { NativeDepsStatus, ResolveOptions } from "./native-deps.js";
import { loadCustomSqlite } from "./vector-store.js";
import { buildTransformersBundle, isBundleFresh } from "./setup-bundle.js";
import type { BundleBuildOptions, BundleBuildResult } from "./setup-bundle.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Runs a command, returns its exit code. Throws on spawn failure (ENOENT). */
export type SetupSpawner = (cmd: string[], cwd: string) => number;

export interface PinnedVersions {
  sqliteVec: string | null;
  transformers: string | null;
}

export interface MemorySetupOptions {
  /** Override deps directory (default: ~/.sentinal/deps). */
  depsDir?: string;
  /** Injectable spawner for tests. Default: spawnSync with inherited stdio. */
  spawner?: SetupSpawner;
  /** Injectable status checker for tests. Default: nativeDepsStatus. */
  statusFn?: (opts: ResolveOptions) => Promise<NativeDepsStatus>;
  /** Injectable platform for tests. Default: os.platform(). */
  platformName?: string;
  /** Injectable Homebrew SQLite check for tests. Default: loadCustomSqlite. */
  sqliteLoader?: () => boolean;
  /** Injectable bundle builder for tests. Default: buildTransformersBundle. */
  bundleBuilder?: (opts: BundleBuildOptions) => Promise<BundleBuildResult>;
  /** Injectable bundle freshness check for tests. Default: isBundleFresh. */
  bundleFreshFn?: (depsDir: string) => boolean;
}

export interface MemorySetupResult {
  ok: boolean;
  report: string;
}

// ─── Version pinning ─────────────────────────────────────────────────────────

/**
 * Read the sqlite-vec / @xenova/transformers version ranges from the root
 * package.json. Returns nulls when unreadable (e.g. inside a compiled
 * binary) — install then falls back to latest.
 */
export function readPinnedVersions(): PinnedVersions {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return {
      sqliteVec: pkg.dependencies?.["sqlite-vec"] ?? null,
      transformers: pkg.dependencies?.["@xenova/transformers"] ?? null,
    };
  } catch {
    return { sqliteVec: null, transformers: null };
  }
}

function pinned(name: string, version: string | null): string {
  return version ? `${name}@${version}` : name;
}

// ─── Spawning ────────────────────────────────────────────────────────────────

/** Default spawner: run synchronously with inherited stdio. */
function defaultSpawner(cmd: string[], cwd: string): number {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", cwd });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

interface InstallAttempt {
  installer: "bun" | "npm" | null;
  exitCode: number;
}

/** Try `bun add` first, then `npm install --prefix`. */
function runInstall(
  spawner: SetupSpawner,
  depsDir: string,
  packages: string[],
): InstallAttempt {
  try {
    return {
      installer: "bun",
      exitCode: spawner(["bun", "add", ...packages], depsDir),
    };
  } catch {
    /* bun unavailable — fall through to npm */
  }

  try {
    return {
      installer: "npm",
      exitCode: spawner(
        ["npm", "install", "--prefix", depsDir, ...packages],
        depsDir,
      ),
    };
  } catch {
    return { installer: null, exitCode: 1 };
  }
}

// ─── Concurrency lock ────────────────────────────────────────────────────────

const LOCK_FILE = ".setup.lock";
/** Locks older than this are considered stale (crashed setup). */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** Returns the live holder PID, or null when the lock is free/stale. */
function lockHolder(depsDir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(depsDir, LOCK_FILE), "utf-8")) as {
      pid?: number;
      time?: number;
    };
    if (typeof raw.pid !== "number" || typeof raw.time !== "number") {
      return null;
    }
    if (Date.now() - raw.time > LOCK_STALE_MS) return null;
    return raw.pid;
  } catch {
    return null;
  }
}

/**
 * Atomically acquire the lock with O_EXCL (`flag: "wx"`) — a plain
 * check-then-write leaves a window where install-foreground and
 * sidecar-self-heal both pass the check. Returns the contending holder PID,
 * or null when the lock was acquired.
 */
function acquireLock(depsDir: string): number | null {
  const payload = JSON.stringify({ pid: process.pid, time: Date.now() });
  const lockPath = join(depsDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return null; // acquired
    } catch {
      const holder = lockHolder(depsDir);
      if (holder !== null) return holder; // live contention
      // Stale/unreadable lock — remove and retry the exclusive create once
      try {
        unlinkSync(lockPath);
      } catch {
        /* raced with another remover */
      }
    }
  }
  return lockHolder(depsDir) ?? -1;
}

function releaseLock(depsDir: string): void {
  try {
    unlinkSync(join(depsDir, LOCK_FILE));
  } catch {
    /* already gone */
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

/**
 * Provision the deps dir, bundle transformers for compiled binaries, and
 * verify native deps resolve afterwards. Fast no-op when already
 * provisioned (runs on every install/update). Concurrency-safe via a
 * PID lockfile — install foreground and sidecar self-heal can race.
 * Report style mirrors `sentinal memory repair`.
 */
export async function runMemorySetup(
  opts: MemorySetupOptions = {},
): Promise<MemorySetupResult> {
  const depsDir = opts.depsDir ?? DEPS_DIR;
  const spawner = opts.spawner ?? defaultSpawner;
  const statusFn = opts.statusFn ?? nativeDepsStatus;
  const platformName = opts.platformName ?? platform();
  const sqliteLoader = opts.sqliteLoader ?? loadCustomSqlite;
  const bundleBuilder = opts.bundleBuilder ?? buildTransformersBundle;
  const bundleFreshFn = opts.bundleFreshFn ?? isBundleFresh;

  const lines: string[] = ["Memory Setup", "============", ""];
  lines.push(`Deps dir: ${depsDir}`);

  mkdirSync(depsDir, { recursive: true });

  // 0a. Fast no-op: everything resolves and the bundle matches the
  // installed version — auto-setup runs on every install/update, so the
  // common case must cost milliseconds.
  const preStatus = await statusFn({ depsDir });
  if (preStatus.transformers && preStatus.sqliteVec && bundleFreshFn(depsDir)) {
    lines.push("", "Already provisioned — nothing to do.");
    return { ok: true, report: lines.join("\n") };
  }

  // 0b. Concurrency lock — freshness only protects against COMPLETED runs.
  const holder = acquireLock(depsDir);
  if (holder !== null) {
    lines.push("", `Setup already running (pid ${holder}) — skipping.`);
    return { ok: false, report: lines.join("\n") };
  }
  try {
    return await provision();
  } finally {
    releaseLock(depsDir);
  }

  async function provision(): Promise<MemorySetupResult> {
    // 1. Provision the deps dir with a private package.json
    writeFileSync(
      join(depsDir, "package.json"),
      JSON.stringify({ private: true }, null, 2) + "\n",
    );

    // 2. Install pinned packages (bun preferred, npm fallback)
    const versions = readPinnedVersions();
    const packages = [
      pinned("sqlite-vec", versions.sqliteVec),
      pinned("@xenova/transformers", versions.transformers),
    ];

    const attempt = runInstall(spawner, depsDir, packages);
    if (attempt.installer === null) {
      lines.push(
        "",
        "Install failed: neither bun nor npm was found on PATH.",
        "Install bun (https://bun.sh) or npm, then re-run: sentinal memory setup",
      );
      return { ok: false, report: lines.join("\n") };
    }

    lines.push(`Installer: ${attempt.installer}`);
    if (attempt.exitCode !== 0) {
      lines.push(
        "",
        `Install failed: ${attempt.installer} exited with code ${attempt.exitCode}.`,
        "Fix the error above and re-run: sentinal memory setup",
      );
      return { ok: false, report: lines.join("\n") };
    }

    // 2b. Bundle transformers for compiled binaries (spike-proven recipe).
    // Runs BEFORE status verification so the bundle path resolves below.
    let bundleOk = false;
    try {
      const bundleResult = await bundleBuilder({
        depsDir,
        spawner: (cmd, o) => spawner(cmd, o?.cwd ?? depsDir),
      });
      bundleOk = bundleResult.ok;
      if (bundleResult.report.length) {
        lines.push("", ...bundleResult.report);
      }
    } catch (e) {
      lines.push("", `Bundling error: ${(e as Error).message}`);
    }

    // 3. Verify the deps actually resolve now
    const status = await statusFn({ depsDir });
    lines.push(
      "",
      `@xenova/transformers: ${status.transformers ? "OK" : "MISSING"}`,
      `sqlite-vec:           ${status.sqliteVec ? "OK" : "MISSING"}`,
    );
    if (status.errors?.length) {
      lines.push("", "Resolution details:");
      for (const err of status.errors) lines.push(`  - ${err}`);
    }

    // When transformers is unresolvable AND no bundle was produced, compiled
    // binaries cannot get semantic search — be honest about why.
    if (!status.transformers && !bundleOk) {
      lines.push(
        "",
        "Note: without the self-contained bundle, compiled sentinal binaries",
        "cannot load @xenova/transformers (bun --compile does not resolve",
        "node_modules for external modules). Install bun (https://bun.sh) or",
        "ensure npx works, then re-run: sentinal memory setup",
        "Keyword (FTS) search continues to work everywhere.",
      );
    }

    // 4. macOS needs Homebrew SQLite for extension loading
    if (platformName === "darwin" && !sqliteLoader()) {
      lines.push(
        "",
        "Homebrew SQLite not found — vector search on macOS requires it:",
        "  brew install sqlite",
      );
    }

    const ok = status.transformers && status.sqliteVec;
    lines.push(
      "",
      ok
        ? "Setup complete. Restart the sidecar to enable vector search."
        : `Setup incomplete — native deps still unavailable. ${SETUP_HINT}`,
    );

    return { ok, report: lines.join("\n") };
  }
}
