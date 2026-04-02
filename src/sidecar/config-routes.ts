/**
 * Config Sidecar Routes
 *
 * Exposes configuration values (like model routing) via the sidecar HTTP API.
 * The OpenCode plugin can't use bun:sqlite directly, so it reads config here.
 */

import type { SidecarContext } from "./server.js";
import { ok } from "./response.js";
import { resolveModelRouting } from "../config/model-routing.js";

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

  return null;
}
