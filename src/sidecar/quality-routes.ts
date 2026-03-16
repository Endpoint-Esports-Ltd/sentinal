/**
 * Sidecar Quality Check Routes
 *
 * POST /quality-check — runs tsc, eslint, and prettier as async subprocesses
 * with timeouts and returns structured results. Uses incremental tsc via
 * tsBuildInfoFile caching in ~/.sentinal/tsbuildinfo/.
 *
 * Node.js-compatible consumers (OpenCode plugin) reach this via HTTP.
 * Bun consumers (Claude Code hooks, MCP tools) can also call runQualityChecks() directly.
 */

import type { SidecarContext } from "./server.js";
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
import { LspClient, isLspAvailable } from "./lsp-client.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────────

const TSBUILDINFO_DIR = join(homedir(), ".sentinal", "tsbuildinfo");
const MTIME_CACHE_DIR = join(homedir(), ".sentinal", "tsbuildinfo-meta");
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_CHECKS: CheckName[] = ["tsc", "eslint", "prettier"];
const MAX_CONCURRENT = 2;

// ─── Concurrency control ─────────────────────────────────────────────────

/** Set of project paths with active quality checks. */
const activeChecks = new Set<string>();

/** Total concurrent quality checks across all projects. */
let concurrentCount = 0;

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(data: unknown = null): Response {
  return json({ ok: true, data });
}

function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
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
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });

  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeout)),
  ]);

  if (timedOut) {
    proc.kill();
    const stderr = await new Response(proc.stderr).text().catch(() => "");
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

async function runTsc(
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

async function runEslint(
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

async function runPrettier(
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

// ─── Shared runner (also callable from MCP tools directly) ───────────────

/**
 * Run quality checks. Used by both the HTTP route handler and the MCP tool
 * fallback path (direct invocation without HTTP round-trip).
 */
async function runTscLsp(
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

export async function runQualityChecks(
  opts: QualityCheckRequest & { lspClient?: LspClient },
): Promise<QualityCheckResult> {
  const { projectPath, filePath, timeout = DEFAULT_TIMEOUT, lspClient } = opts;
  const checks = opts.checks ?? DEFAULT_CHECKS;
  const result: QualityCheckResult = {};

  if (checks.includes("tsc")) {
    // Try LSP first, fall back to tsc subprocess
    if (lspClient) {
      const lspResult = await runTscLsp(lspClient, projectPath);
      if (!lspResult.errors.includes("LSP diagnostics failed")) {
        result.tsc = lspResult;
      } else {
        result.tsc = await runTsc(projectPath, timeout);
      }
    } else {
      result.tsc = await runTsc(projectPath, timeout);
    }
  }
  if (checks.includes("eslint")) {
    result.eslint = await runEslint(projectPath, filePath, timeout);
  }
  if (checks.includes("prettier")) {
    result.prettier = await runPrettier(projectPath, filePath, timeout);
  }

  return result;
}

// ─── Route Handler ───────────────────────────────────────────────────────

export async function handleQualityRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;

  if (path === "/quality-check" && method === "POST") {
    const body = await readBody<QualityCheckRequest>(req);

    if (!body.projectPath) {
      return fail("projectPath is required");
    }
    if (!existsSync(body.projectPath)) {
      return fail(`Project path not found: ${body.projectPath}`);
    }

    // Concurrency control: reject duplicate per-project and limit total
    if (activeChecks.has(body.projectPath)) {
      return fail(
        "Quality check already running for this project. Try again shortly.",
        429,
      );
    }
    if (concurrentCount >= MAX_CONCURRENT) {
      return fail(
        `Too many concurrent quality checks (max ${MAX_CONCURRENT}). Try again shortly.`,
        429,
      );
    }

    activeChecks.add(body.projectPath);
    concurrentCount++;
    try {
      // Lazy-init LSP client on first diagnostics request
      if (!ctx.lspClient && isLspAvailable()) {
        ctx.lspClient = new LspClient();
      }
      const result = await runQualityChecks({
        ...body,
        lspClient: ctx.lspClient,
      });
      return ok(result);
    } finally {
      activeChecks.delete(body.projectPath);
      concurrentCount--;
    }
  }

  // Not a quality route — return null to fall through
  return null;
}
