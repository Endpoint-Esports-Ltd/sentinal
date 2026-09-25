/**
 * Sidecar Quality Check Routes
 *
 * POST /quality-check — runs tsc, eslint, and prettier as async subprocesses
 * with timeouts and returns structured results. Uses incremental tsc via
 * tsBuildInfoFile caching in ~/.sentinal/tsbuildinfo/.
 *
 * The subprocess machinery and per-tool runners live in quality-runners.ts
 * (split by cohesion); this module owns the HTTP route handler and the
 * concurrency control around it.
 *
 * Node.js-compatible consumers (OpenCode plugin) reach this via HTTP.
 * Bun consumers (Claude Code hooks, MCP tools) can also call runQualityChecks() directly.
 */

import type { SidecarContext } from "./server.js";
import { ok, fail, readBody } from "./response.js";
import { existsSync } from "node:fs";
import { LspClient, isLspAvailable } from "./lsp-client.js";
import {
  runTsc,
  runTscLsp,
  resolveQualityTarget,
  type CheckName,
  type QualityCheckRequest,
  type QualityCheckResult,
} from "./quality-runners.js";
import { runEslint, runPrettier } from "./quality-lint.js";

// Re-export the public surface that moved to quality-runners.ts so existing
// import sites (server.ts, analysis/mcp-tools.ts, client.ts, tests) are
// unaffected by the split.
export { getToolCommand, resolveQualityTarget } from "./quality-runners.js";
export type {
  CheckName,
  FixMode,
  QualityCheckRequest,
  RuleCount,
  ToolResult,
  QualityCheckResult,
} from "./quality-runners.js";

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_CHECKS: CheckName[] = ["tsc", "eslint", "prettier"];
const MAX_CONCURRENT = 2;

// ─── Concurrency control ─────────────────────────────────────────────────

/** Set of project paths with active quality checks. */
const activeChecks = new Set<string>();

/** Total concurrent quality checks across all projects. */
let concurrentCount = 0;

// ─── Shared runner (also callable from MCP tools directly) ───────────────

/**
 * Run quality checks. Used by both the HTTP route handler and the MCP tool
 * fallback path (direct invocation without HTTP round-trip).
 *
 * D1: with `filePath`, eslint/prettier fix ONLY that file (resolved against
 * the project; throws before running anything if it is outside). Without it,
 * everything is report-only — nothing is rewritten.
 */
export async function runQualityChecks(
  opts: QualityCheckRequest & { lspClient?: LspClient },
): Promise<QualityCheckResult> {
  const { projectPath, timeout = DEFAULT_TIMEOUT, lspClient } = opts;
  const filePath = opts.filePath
    ? resolveQualityTarget(projectPath, opts.filePath)
    : undefined;
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
    // D1: refuse a file outside the project before taking the lock.
    if (body.filePath) {
      try {
        resolveQualityTarget(body.projectPath, body.filePath);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
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
