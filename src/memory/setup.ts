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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEPS_DIR, nativeDepsStatus, SETUP_HINT } from "./native-deps.js";
import type { NativeDepsStatus, ResolveOptions } from "./native-deps.js";
import { loadCustomSqlite } from "./vector-store.js";

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

// ─── Setup ───────────────────────────────────────────────────────────────────

/**
 * Provision the deps dir and verify native deps resolve afterwards.
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

  const lines: string[] = ["Memory Setup", "============", ""];
  lines.push(`Deps dir: ${depsDir}`);

  // 1. Provision the deps dir with a private package.json
  mkdirSync(depsDir, { recursive: true });
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

  // Known limitation: bun --compile binaries cannot walk node_modules for
  // external modules' bare imports, so transformers fails to load even when
  // correctly installed in the deps dir. Be honest about the workaround.
  if (
    !status.transformers &&
    status.errors?.some((e) => e.includes("deps dir import"))
  ) {
    lines.push(
      "",
      "Note: the compiled sentinal binary cannot load @xenova/transformers",
      "(bun --compile does not resolve node_modules for external modules).",
      "Semantic search currently requires running the sidecar via bun from a",
      "source checkout: bun <repo>/src/cli/index.ts sidecar start -d",
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
