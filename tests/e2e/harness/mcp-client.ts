// Minimal stdio MCP client for E2E tests.
//
// Thin wrapper around the official @modelcontextprotocol/sdk Client +
// StdioClientTransport (dep 1.27.1). We do NOT hand-roll JSON-RPC framing —
// the SDK owns initialize/tools-list/tools-call framing. This wrapper just
// spawns `sentinal mcp-server` in the sandbox env and exposes connect /
// listTools / callTool / close.
//
// The sentinal entrypoint is resolved the same way the sandbox harness does:
// prefer the compiled dist/sentinal (matches what users install AND bundles
// sqlite-vec so memory tools work in-subprocess without the bunfig preload),
// else fall back to `bun src/cli/index.ts`.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Repo root = three levels up from tests/e2e/harness/.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_SRC = join(REPO_ROOT, "src", "cli", "index.ts");
const CLI_COMPILED = join(REPO_ROOT, "dist", "sentinal");

export interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

// Resolve the server command+args. Honors SENTINAL_E2E_BINARY (the same
// override the sandbox harness uses) FIRST so release-gate tests spawn the
// binary under test — THROWS if set-but-missing (no silent dev fallback).
// Otherwise prefers the compiled dist/sentinal (bundles sqlite-vec — no
// vec0/preload issue for memory tools); else runs bun on src.
function serverCommand(): { command: string; args: string[] } {
  const override = process.env.SENTINAL_E2E_BINARY;
  if (override) {
    const abs = resolve(override);
    if (!existsSync(abs)) {
      throw new Error(
        `SENTINAL_E2E_BINARY is set to "${override}" but that file does not exist.`,
      );
    }
    return { command: abs, args: ["mcp-server"] };
  }
  if (existsSync(CLI_COMPILED)) {
    return { command: CLI_COMPILED, args: ["mcp-server"] };
  }
  return { command: "bun", args: [CLI_SRC, "mcp-server"] };
}

// A tiny, test-focused wrapper over the SDK Client.
export class McpTestClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private readonly env: Record<string, string | undefined>) {}

  async connect(): Promise<void> {
    const { command, args } = serverCommand();
    // The SDK env map must be string-only; drop undefined values.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === "string") env[k] = v;
    }
    this.transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "pipe",
    });
    this.client = new Client({ name: "sentinal-e2e", version: "0.0.0" });
    await this.client.connect(this.transport);
  }

  // Returns the flat list of tool names exposed by the server.
  async listTools(): Promise<string[]> {
    if (!this.client) throw new Error("McpTestClient not connected");
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  // Call a tool by name; returns the raw result (content array + isError).
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    if (!this.client) throw new Error("McpTestClient not connected");
    return (await this.client.callTool({
      name,
      arguments: args,
    })) as McpToolResult;
  }

  // Close the client and kill the spawned server subprocess.
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best effort
    }
    try {
      await this.transport?.close();
    } catch {
      // best effort
    }
    this.client = null;
    this.transport = null;
  }
}
