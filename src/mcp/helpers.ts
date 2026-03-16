/**
 * Shared helpers for MCP tool responses.
 *
 * Eliminates the repeated `{ content: [{ type: "text" as const, text }] }` boilerplate
 * across all MCP tool handler files.
 */

/** Wrap a text string in the MCP tool response format. */
export function mcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Format an unknown error with a prefix into an MCP tool response. */
export function mcpError(prefix: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return mcpText(`${prefix}: ${msg}`);
}
