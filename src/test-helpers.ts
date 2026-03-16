/**
 * Shared test setup helpers.
 *
 * Eliminates duplicate makeTmpDir() (19 files) and captureTools() (4 files).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Create a temporary directory for tests.
 * @param prefix - Optional prefix (default: "sentinal-test")
 */
export function makeTmpDir(prefix = "sentinal-test"): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return type for MCP tool handlers captured by captureTools(). */
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>;

/**
 * Register MCP tools and capture their handler functions for direct testing.
 *
 * Monkey-patches McpServer.tool() to intercept handler registrations,
 * then calls the provided register function.
 *
 * @param registerFn - The register function (e.g. registerTddTools)
 * @param deps - Dependencies to pass to the register function
 * @returns Map of tool name → handler function
 */
export function captureTools<D>(
  registerFn: (server: McpServer, deps: D) => void,
  deps: D,
): Map<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0.0.1" });

  const tools = new Map<string, ToolHandler>();
  const origTool = server.tool.bind(server);
  server.tool = ((...args: unknown[]) => {
    if (args.length >= 4 && typeof args[0] === "string") {
      const name = args[0] as string;
      const handler = args[3] as ToolHandler;
      tools.set(name, handler);
    }
    return origTool(...(args as Parameters<typeof origTool>));
  }) as typeof server.tool;

  registerFn(server, deps);
  return tools;
}
