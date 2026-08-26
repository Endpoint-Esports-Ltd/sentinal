/**
 * Spec MCP Tools — registration surface
 *
 * ⛔ `registerSpecTools` is the single entry point `src/mcp/server.ts:51` calls.
 * The nine `spec_*` tools are split across sibling modules for file length
 * (`./status-mcp-tools.ts`, `./events-mcp-tools.ts`), and the parent is the
 * only thing that calls their register functions. Dropping one of those calls
 * would silently unregister a whole group of tools while every behavioural test
 * in `./mcp-tools.test.ts` — which pulls handlers out of a monkey-patched
 * `server.tool` — kept passing for the survivors.
 *
 * So this asserts the tools the *server actually advertises over the wire*, via
 * a real `Client` on an `InMemoryTransport`, the way `src/analysis/impact.test.ts`
 * does. That is the only check that fails when a delegate call goes missing.
 */

import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSpecTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";

/** The full advertised surface of the spec domain. */
const SPEC_TOOLS = [
  "spec_register",
  "spec_wait_file",
  "spec_config",
  "spec_plan_parse",
  "spec_notify",
  "spec_events",
  "spec_status",
  "spec_init",
  "spec_metrics",
] as const;

/**
 * Register through the production entry point and ask the server what it lists.
 *
 * Deps mirror production (`{client, store: null}`) so no MemoryStore/SQLite
 * handle is opened — registration never touches the store.
 */
async function advertisedToolNames(): Promise<string[]> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerSpecTools(server, {
    client: {} as SidecarClient,
    store: null,
  });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("registerSpecTools registration surface", () => {
  it("advertises all nine spec_* tools", async () => {
    const names = await advertisedToolNames();

    for (const tool of SPEC_TOOLS) {
      expect(
        names,
        `${tool} is not listed by the server — a register delegate is missing`,
      ).toContain(tool);
    }
  });

  it("advertises exactly those nine and nothing else", async () => {
    const names = await advertisedToolNames();

    expect(names.filter((n) => n.startsWith("spec_")).sort()).toEqual(
      [...SPEC_TOOLS].sort(),
    );
    expect(names).toHaveLength(SPEC_TOOLS.length);
  });
});
