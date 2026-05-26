/**
 * Config Sidecar Routes
 *
 * Exposes configuration values (like model routing) via the sidecar HTTP API.
 * The OpenCode plugin can't use bun:sqlite directly, so it reads config here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SidecarContext } from "./server.js";
import { ok } from "./response.js";
import { resolveModelRouting } from "../config/model-routing.js";

const DEFAULT_COMPACTION_RESERVED = 10000;

/**
 * Read compaction.reserved from a project's opencode.json.
 * Returns DEFAULT_COMPACTION_RESERVED on any error (file not found, invalid JSON, missing key).
 */
function readCompactionReserved(projectPath: string): number {
  try {
    const raw = readFileSync(join(projectPath, "opencode.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const compaction = config.compaction as Record<string, unknown> | undefined;
    const reserved = compaction?.reserved;
    if (typeof reserved === "number") return reserved;
  } catch {
    // file not found or JSON parse error — fall through to default
  }
  return DEFAULT_COMPACTION_RESERVED;
}

/**
 * Handle /config/* requests. Returns null for non-matching paths.
 */
export async function handleConfigRequest(
  req: Request,
  ctx: SidecarContext,
): Promise<Response | null> {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/config/model-routing" && req.method === "GET") {
    const routing = resolveModelRouting(ctx.store);
    return ok(routing);
  }

  if (url.pathname === "/config/compaction" && req.method === "GET") {
    const project = url.searchParams.get("project");
    if (!project) {
      return ok({ reserved: DEFAULT_COMPACTION_RESERVED });
    }
    const reserved = readCompactionReserved(project);
    return ok({ reserved });
  }

  return null;
}
