/**
 * Project Context Sidecar Routes
 *
 * Handles the /project-context endpoint with in-memory caching.
 * Separated from routes.ts to stay under the 400-line limit.
 */

import { resolve } from "node:path";
import { ok, fail } from "./response.js";
import { analyzeProject, type ProjectContext } from "../project/context.js";

// ─── Cache ────────────────────────────────────────────────────────────────────

const projectContextCache = new Map<string, ProjectContext>();

// ─── Route Handler ────────────────────────────────────────────────────────────

/**
 * Handle /project-context requests. Returns null for non-matching paths.
 * This allows the main fetch handler to try other route handlers.
 */
export async function handleProjectContextRequest(
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/project-context" || req.method !== "GET") return null;

  const projectPath = url.searchParams.get("project");
  if (!projectPath) {
    return fail("Missing 'project' parameter");
  }

  const refresh = url.searchParams.get("refresh") === "true";
  const cacheKey = resolve(projectPath);

  if (!refresh && projectContextCache.has(cacheKey)) {
    return ok(projectContextCache.get(cacheKey));
  }

  try {
    const ctx = analyzeProject(projectPath);
    projectContextCache.set(cacheKey, ctx);
    return ok(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Analysis failed: ${msg}`, 500);
  }
}

/** Clear the cache (for testing) */
export function clearProjectContextCache(): void {
  projectContextCache.clear();
}
