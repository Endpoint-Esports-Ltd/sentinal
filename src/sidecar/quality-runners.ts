/**
 * Quality Check Runners
 *
 * Subprocess machinery for the sidecar quality checks: tool resolution,
 * timeout-bounded spawning, the shared result types, and the tsc runners
 * (plus the LSP-backed fast path). Split from quality-routes.ts by
 * cohesion — the route handler and concurrency control live there. The
 * eslint/prettier runners live in quality-lint.ts (which imports from here).
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
import { getSentinalHome } from "../memory/db-path.js";
import { detectPackageManager } from "../checkers/detect.js";
import { parseTscOutput } from "../analysis/helpers.js";
import { projectHash } from "../analysis/helpers.js";
import type { LspClient } from "./lsp-client.js";
import type { RuleCount } from "./quality-summary.js";

export { resolveQualityTarget } from "./quality-summary.js";
export type { RuleCount } from "./quality-summary.js";

// ─── Types ───────────────────────────────────────────────────────────────

export type CheckName = "tsc" | "eslint" | "prettier";

export interface QualityCheckRequest {
  projectPath: string;
  filePath?: string;
  checks?: CheckName[];
  timeout?: number;
}

/**
 * eslint/prettier fix scope (D1). `"file"`: an explicit `file` was given and
 * only it may be rewritten. `"none"`: project-wide — report-only, nothing is
 * ever rewritten. Absent on tsc and on results from sidecars ≤ v1.38.
 */
export type FixMode = "file" | "none";

/** Every D1 field is OPTIONAL: old clients ignore them, new renderers
 * tolerate results from old sidecars. */
export interface ToolResult {
  ok: boolean;
  /** Human lines. Project-wide: prettier files / eslint `file:line rule`. */
  errors: string[];
  durationMs: number;
  /** True only when the given `file` was actually rewritten. */
  autoFixed?: boolean;
  incremental?: boolean;
  timedOut?: boolean;
  fixMode?: FixMode;
  /** prettier, project-wide: first MAX_LISTED unformatted files. */
  files?: string[];
  /** prettier, project-wide: total unformatted files. */
  fileCount?: number;
  /** eslint, project-wide: totals from `--format json`. */
  errorCount?: number;
  warningCount?: number;
  topRules?: RuleCount[];
}

export interface QualityCheckResult {
  tsc?: ToolResult;
  eslint?: ToolResult;
  prettier?: ToolResult;
}

// ─── Constants ───────────────────────────────────────────────────────────

const POST_KILL_READ_DEADLINE_MS = 2_000;

// D2: resolved through getSentinalHome() on every call (never cached at
// module load) so a SENTINAL_HOME override — set for every test run —
// redirects the cache instead of writing to the real ~/.sentinal tree.
function tsBuildInfoDir(): string {
  return join(getSentinalHome(), "tsbuildinfo");
}
function mtimeCacheDir(): string {
  return join(getSentinalHome(), "tsbuildinfo-meta");
}

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
export async function runWithTimeout(
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
  const metaPath = join(mtimeCacheDir(), `${hash}.json`);
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
  mkdirSync(mtimeCacheDir(), { recursive: true });
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
  const tsBuildInfoPath = join(tsBuildInfoDir(), `${hash}.tsbuildinfo`);

  mkdirSync(tsBuildInfoDir(), { recursive: true });

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
