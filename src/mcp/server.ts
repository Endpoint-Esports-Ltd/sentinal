/**
 * Sentinal MCP Server
 *
 * Universal entrypoint for all Sentinal MCP tools.
 * Registers tool modules from different domains (memory, spec, worktree)
 * on a single McpServer instance.
 *
 * Run: sentinal mcp-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "../memory/store.js";
import { isMemoryEnabled } from "../memory/config.js";
import { registerMemoryTools } from "../memory/mcp-tools.js";
import { registerSpecTools } from "../spec/mcp-tools.js";
import { registerWorktreeTools } from "../worktree/mcp-tools.js";
import { registerTddTools } from "../tdd/mcp-tools.js";
import { registerAnalysisTools } from "../analysis/mcp-tools.js";
import { registerProjectTools } from "../project/mcp-tools.js";
import { registerRuntimeTools } from "../runtime/mcp-tools.js";
import { runtimeWorktreeConfig } from "../runtime/worktree-deps.js";
import { SidecarClient } from "../sidecar/client.js";
import { autoStartSidecar, stopSidecarProcess } from "../sidecar/lifecycle.js";

// --- Server Factory ---

export interface ServerOptions {
  store?: MemoryStore;
  client?: SidecarClient | null;
}

/**
 * Create the unified Sentinal MCP server with all tool modules registered.
 * When a sidecar client is provided, tools delegate DB ops to the sidecar.
 * Falls back to direct MemoryStore when no client is available.
 */
export function createSentinalServer(opts: ServerOptions = {}): {
  server: McpServer;
  store: MemoryStore | null;
} {
  const client = opts.client ?? null;
  const store = client ? null : (opts.store ?? new MemoryStore());

  const server = new McpServer({
    name: "sentinal",
    version: "0.4.0",
  });

  registerMemoryTools(server, { client, store });
  registerSpecTools(server, { client, store });
  // ⛔ The worktree tools cannot build this themselves: `src/worktree/` may
  // import nothing from `src/runtime/` (no-module-cycle guard), and
  // `worktree/mcp-tools.ts` constructs a manager from inside that directory.
  // Threading the config down from here is what keeps the graph acyclic.
  registerWorktreeTools(server, {
    client,
    store,
    worktreeConfig: runtimeWorktreeConfig(),
  });
  registerTddTools(server, { client, store });
  registerAnalysisTools(server, { client, store });
  registerProjectTools(server, { client });
  // Direct-only by design — a stateless fs read of a path derived from the
  // tool's own `project` argument, so the sidecar's warm state buys nothing.
  // See the docblock in src/runtime/mcp-tools.ts before adding a route.
  registerRuntimeTools(server, {});

  return { server, store };
}

// --- Cleanup Handlers ---

/**
 * Register process cleanup handlers for the MCP server.
 * Returns a cleanup function that can be called directly (for testing)
 * or is invoked automatically on SIGTERM/SIGINT/exit.
 *
 * Client mode (store === null, i.e. production): NEVER stops the sidecar.
 * The sidecar is shared across concurrent sessions and owns its own
 * lifecycle — session-aware idle shutdown including a sessions-never-seen
 * fallback (src/sidecar/server.ts:235-241) — so MCP-only usage cannot
 * orphan it, and stopping it here would kill it out from under other
 * live sessions.
 *
 * Direct-store mode: stops the sidecar only when no active sessions remain.
 *
 * SIGTERM/SIGINT run cleanup then exit (143/130) — a swallowing handler
 * would otherwise leave the process alive after `kill <pid>`.
 */
export function registerMcpCleanupHandlers(
  store: MemoryStore | null,
): () => void {
  let ran = false;
  const cleanup = () => {
    // process.exit() from a signal handler re-fires this via the exit event.
    if (ran) return;
    ran = true;
    try {
      if (!store) return; // client mode — sidecar owns its own lifecycle
      const active = store.getActiveSessions();
      if (active.length > 0) return;
      stopSidecarProcess();
    } catch {
      // Non-fatal — best effort cleanup
    }
  };

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  // Must stay sync — the exit event cannot await anything.
  process.on("exit", cleanup);

  return cleanup;
}

// --- Main (stdio transport) ---

export async function main(): Promise<void> {
  if (!isMemoryEnabled()) {
    console.error("Sentinal is disabled via config. Exiting.");
    process.exit(0);
  }

  autoStartSidecar();

  // Use connectWithRetry so the fire-and-forget autoStartSidecar() has time to come up
  const client = await SidecarClient.connectWithRetry();
  const { server, store } = createSentinalServer({ client });

  // Register cleanup handlers (registers its own SIGTERM/SIGINT/exit
  // listeners — do NOT add another `exit` registration here).
  registerMcpCleanupHandlers(store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Sentinal MCP Server running on stdio (${
      client ? "sidecar" : "direct"
    } mode)`,
  );
}

// Only run main when executed directly (not when imported by the CLI dispatcher)
const isMainModule =
  !process.env.__SENTINAL_CLI &&
  (typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : import.meta.url === `file://${process.argv[1]}`);

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
