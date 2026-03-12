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
import { SidecarClient } from "../sidecar/client.js";
import { autoStartSidecar } from "../sidecar/lifecycle.js";

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
  registerWorktreeTools(server, { client, store });
  registerTddTools(server, { client, store });

  return { server, store };
}

// --- Main (stdio transport) ---

export async function main(): Promise<void> {
  if (!isMemoryEnabled()) {
    console.error("Sentinal is disabled via config. Exiting.");
    process.exit(0);
  }

  autoStartSidecar();

  // Try sidecar first, fall back to direct MemoryStore
  const client = await SidecarClient.connect();
  const { server } = createSentinalServer({ client });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Sentinal MCP Server running on stdio (${client ? "sidecar" : "direct"} mode)`);
}

// Only run main when executed directly (not when imported by the CLI dispatcher)
const isMainModule = !process.env.__SENTINAL_CLI && (
  typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : import.meta.url === `file://${process.argv[1]}`
);

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
