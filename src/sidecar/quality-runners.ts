/**
 * Quality Check Runners
 *
 * Subprocess machinery for the sidecar quality checks: tool resolution,
 * timeout-bounded spawning, and the per-tool runners (tsc/eslint/prettier,
 * plus the LSP-backed tsc fast path). Split from quality-routes.ts by
 * cohesion — the route handler and concurrency control live there.
 */

import {
  existsSync,
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectPackageManager } from "../checkers/detect.js";
import { parseTscOutput } from "../analysis/helpers.js";
import { projectHash } from "../analysis/helpers.js";
import type { LspClient } from "./lsp-client.js";

// ─── Types ───────────────────────────────────────────────────────────────

export type CheckName = "tsc" | "eslint" | "prettier";

export interface QualityCheckRequest {
  projectPath: string;
  filePath?: string;
  checks?: CheckName[];
  timeout?: number;
}

export interface ToolResult {
  ok: boolean;
  errors: string[];
  durationMs: number;
  autoFixed?: boolean;
  incremental?: boolean;
  timedOut?: boolean;
}

export interface QualityCheckResult {
  tsc?: ToolResult;
  eslint?: ToolResult;
  prettier?: ToolResult;
}

// ─── Constants ───────────────────────────────────────────────────────────

const TSBUILDINFO_DIR = join(homedir(), ".sentinal", "tsbuildinfo");
const MTIME_CACHE_DIR = join(homedir(), ".sentinal", "tsbuildinfo-meta");
const POST_KILL_READ_DEADLINE_MS = 2_000;

// ─── Subprocess machinery ────────────────────────────────────────────────

/**
 * Resolve the command prefix for a tool (e.g. eslint, prettier, tsc).
 * Prefers a local node_modules/.bin binary over bunx/npx to avoid
 * broken transitive dependencies in temp-installed packages.
 *
 * Returns a string[] command prefix including the tool name.
 *   Local:    ['/abs/path/node_modules/.bin/eslint']
 *   Fallback: ['bunx', 'eslint']
 */
export function getToolCommand(
  projectPath: string,
  toolName: string,
): string[] {
  const localBin = join(projectPath, "node_modules", ".bin", toolName);
  if (existsSync(localBin)) {
    return [localBin];
  }
  const pm = detectPackageManager(projectPath);
  return pm === "bun" ? ["bunx", toolName] : ["npx", toolName];
}

/** Best-effort SIGKILL of the subprocess group (catches bunx/npx grandchildren).
 * POSIX-only, and NEVER the correctness mechanism — the read-deadline race is. */
function killGroupBestEffort(pid: number): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
}

/**
 * Run a subprocess with a timeout. Returns { stdout, stderr, exitCode, timedOut }.
 */
async function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeout: number,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  // detached → own process group, so killGroupBestEffort can reach grandchildren
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeout)),
  ]);

  if (timedOut) {
    proc.kill();
    // A bunx/npx grandchild can ignore SIGTERM and hold stderr open forever —
    // never block the caller (and activeChecks) on the post-kill read. Race
    // it against a short deadline; on loss, escalate and return what we have.
    let lost = false;
    const stderr = await Promise.race([
      new Response(proc.stderr).text().catch(() => ""),
      new Promise<string>((resolve) =>
        setTimeout(
          () => ((lost = true), resolve("")),
          POST_KILL_READ_DEADLINE_MS,
        ),
      ),
    ]);
    if (lost) killGroupBestEffort(proc.pid);
    return { stdout: "", stderr, exitCode: -1, timedOut: true };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: proc.exitCode ?? 1, timedOut: false };
}

// ─── tsbuildinfo invalidation ────────────────────────────────────────────

function shouldInvalidateTsBuildInfo(
  projectPath: string,
  hash: string,
): boolean {
  const metaPath = join(MTIME_CACHE_DIR, `${hash}.json`);
  const pkgPath = join(projectPath, "package.json");
  const tsconfigPath = join(projectPath, "tsconfig.json");

  let cachedMtimes: { pkg?: number; tsconfig?: number } = {};
  try {
    if (existsSync(metaPath)) {
      cachedMtimes = JSON.parse(readFileSync(metaPath, "utf-8"));
    }
  } catch {
    /* corrupted, treat as invalidated */
  }

  const pkgMtime = existsSync(pkgPath) ? statSync(pkgPath).mtimeMs : 0;
  const tsconfigMtime = existsSync(tsconfigPath)
    ? statSync(tsconfigPath).mtimeMs
    : 0;

  const changed =
    pkgMtime !== cachedMtimes.pkg || tsconfigMtime !== cachedMtimes.tsconfig;

  // Always update cache
  mkdirSync(MTIME_CACHE_DIR, { recursive: true });
  writeFileSync(
    metaPath,
    JSON.stringify({ pkg: pkgMtime, tsconfig: tsconfigMtime }),
  );

  return changed;
}

// ─── Individual check runners ────────────────────────────────────────────

export async function runTsc(
  projectPath: string,
  timeout: number,
): Promise<ToolResult> {
  const start = Date.now();
  const hash = projectHash(projectPath);
  const tsBuildInfoPath = join(TSBUILDINFO_DIR, `${hash}.tsbuildinfo`);

  mkdirSync(TSBUILDINFO_DIR, { recursive: true });

  // Invalidate tsbuildinfo if package.json or tsconfig.json changed
  if (shouldInvalidateTsBuildInfo(projectPath, hash)) {
    try {
      unlinkSync(tsBuildInfoPath);
    } catch {
      /* doesn't exist */
    }
  }

  const incremental = true;
  const cmd = [
    ...getToolCommand(projectPath, "tsc"),
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "--tsBuildInfoFile",
    tsBuildInfoPath,
  ];

  const result = await runWithTimeout(cmd, projectPath, timeout);
  const durationMs = Date.now() - start;

  if (result.timedOut) {
    return {
      ok: false,
      errors: ["tsc timed out"],
      durationMs,
      incremental,
      timedOut: true,
    };
  }

  const errors = parseTscOutput(result.stdout).map(
    (e) => `${e.file}(${e.line},${e.column}): ${e.message}`,
  );

  return {
    ok: result.exitCode === 0,
    errors,
    durationMs,
    incremental,
  };
}

export async function runEslint(
  projectPath: string,
  filePath: string | undefined,
  timeout: number,
): Promise<ToolResult> {
  const start = Date.now();
  const target = filePath ?? ".";

  // Detect auto-fix by comparing file mtime before/after (for single-file mode)
  let mtimeBefore = 0;
  if (filePath && existsSync(filePath)) {
    try {
      mtimeBefore = statSync(filePath).mtimeMs;
    } catch {
      /* ok */
    }
  }

  const cmd = [...getToolCommand(projectPath, "eslint"), "--fix", target];
  const result = await runWithTimeout(cmd, projectPath, timeout);
  const durationMs = Date.now() - start;

  if (result.timedOut) {
    return {
      ok: false,
      errors: ["eslint timed out"],
      durationMs,
      timedOut: true,
    };
  }

  const hasErrors = result.exitCode !== 0;
  // Parse stdout for actual lint messages (eslint outputs to stdout by default)
  const rawOutput = result.stdout || result.stderr;
  const errors = hasErrors
    ? rawOutput
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(0, 10)
    : [];

  // Detect auto-fix via mtime change
  let autoFixed = false;
  if (!hasErrors && filePath && existsSync(filePath) && mtimeBefore > 0) {
    try {
      autoFixed = statSync(filePath).mtimeMs !== mtimeBefore;
    } catch {
      /* ok */
    }
  }

  return { ok: !hasErrors, errors, durationMs, autoFixed };
}

export async function runPrettier(
  projectPath: string,
  filePath: string | undefined,
  timeout: number,
): Promise<ToolResult> {
  const start = Date.now();
  const prettierCmd = getToolCommand(projectPath, "prettier");
  const target = filePath ?? ".";

  // First: check
  const check = await runWithTimeout(
    [...prettierCmd, "--check", target],
    projectPath,
    timeout,
  );

  if (check.timedOut) {
    return {
      ok: false,
      errors: ["prettier timed out"],
      durationMs: Date.now() - start,
      timedOut: true,
    };
  }

  if (check.exitCode === 0) {
    return {
      ok: true,
      errors: [],
      durationMs: Date.now() - start,
      autoFixed: false,
    };
  }

  // Issues found — auto-fix
  const fix = await runWithTimeout(
    [...prettierCmd, "--write", target],
    projectPath,
    timeout,
  );

  const durationMs = Date.now() - start;

  if (fix.timedOut) {
    return {
      ok: false,
      errors: ["prettier --write timed out"],
      durationMs,
      timedOut: true,
    };
  }

  return {
    ok: true,
    errors: [],
    durationMs,
    autoFixed: true,
  };
}

export async function runTscLsp(
  lspClient: LspClient,
  projectPath: string,
): Promise<ToolResult> {
  const start = Date.now();
  try {
    const diagnostics = await lspClient.getDiagnostics(projectPath);
    const errors = diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${d.file}(${d.line},${d.column}): ${d.message}`);
    return {
      ok: errors.length === 0,
      errors,
      durationMs: Date.now() - start,
      incremental: true,
    };
  } catch {
    return {
      ok: false,
      errors: ["LSP diagnostics failed"],
      durationMs: Date.now() - start,
      incremental: false,
    };
  }
}
