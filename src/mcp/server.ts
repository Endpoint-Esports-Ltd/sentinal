/**
 * Sentinal MCP Server
 *
 * Universal entrypoint for all Sentinal MCP tools.
 * Registers tool modules from different domains (memory, spec)
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

// --- Server Factory ---

/**
 * Create the unified Sentinal MCP server with all tool modules registered.
 * Exported for testing — call `createSentinalServer()` then `server.connect(transport)`.
 */
export function createSentinalServer(store?: MemoryStore): {
  server: McpServer;
  store: MemoryStore;
} {
  const s = store ?? new MemoryStore();

  const server = new McpServer({
    name: "sentinal",
    version: "0.2.0",
  });

  registerMemoryTools(server, s);
  registerSpecTools(server, s);

  return { server, store: s };
}

// --- Main (stdio transport) ---

export async function main(): Promise<void> {
  if (!isMemoryEnabled()) {
    console.error("Sentinal is disabled via config. Exiting.");
    process.exit(0);
  }

  const { server } = createSentinalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sentinal MCP Server running on stdio");
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
