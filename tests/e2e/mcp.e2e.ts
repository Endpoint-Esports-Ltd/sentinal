// MCP tools E2E.
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/mcp.e2e.ts
//
// Drives the sandbox `sentinal mcp-server` over stdio JSON-RPC using the
// official @modelcontextprotocol/sdk Client (via McpTestClient) — no
// hand-rolled framing. We install into the sandbox first (so the server's
// MCP config exists), though the server is spawned directly by the client.
//
// Observed against the compiled dist/sentinal binary: the tool list includes
// all 28 tools; spec_status returns a well-formed content array; memory_search
// works in-subprocess (the compiled binary bundles sqlite-vec, so vec0 loads).

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";
import { McpTestClient } from "./harness/mcp-client.ts";

const TIMEOUT = 120_000;

describe("MCP tools E2E — sentinal mcp-server", () => {
  let realBefore: Record<string, string> = {};

  beforeAll(() => {
    realBefore = snapshotRealDirs();
  });

  let sb: Sandbox | null = null;
  let mcp: McpTestClient | null = null;

  afterEach(async () => {
    await mcp?.close();
    mcp = null;
    sb?.cleanup();
    sb = null;
    // Backstop: the real user dirs must be byte-unchanged after the run.
    assertNoRealEscape(realBefore);
  });

  it(
    "listTools() includes memory_search, spec_status, tdd_status",
    async () => {
      sb = createSandbox();
      // Install so the MCP server config exists in the sandbox.
      const r = sb.install("opencode");
      expect(r.exitCode).toBe(0);

      mcp = new McpTestClient(sb.env);
      await mcp.connect();
      const names = await mcp.listTools();

      expect(names).toContain("memory_search");
      expect(names).toContain("spec_status");
      expect(names).toContain("tdd_status");
    },
    TIMEOUT,
  );

  it(
    "callTool('spec_status') returns a well-formed (non-error) result",
    async () => {
      sb = createSandbox();
      sb.install("opencode");

      mcp = new McpTestClient(sb.env);
      await mcp.connect();

      const res = await mcp.callTool("spec_status", { project: sb.home });

      // Well-formed: a content array is present, no isError flag.
      expect(res.isError).toBeFalsy();
      expect(Array.isArray(res.content)).toBe(true);
      expect(res.content!.length).toBeGreaterThan(0);
      expect(res.content![0].type).toBe("text");
    },
    TIMEOUT,
  );

  it(
    "callTool('memory_search') returns a well-formed result (empty is fine)",
    async () => {
      sb = createSandbox();
      sb.install("opencode");

      mcp = new McpTestClient(sb.env);
      await mcp.connect();

      // The compiled binary bundles sqlite-vec so this succeeds in-subprocess.
      // A graceful error result would also be acceptable, so we assert the
      // shape (content array present) rather than isError being false.
      const res = await mcp.callTool("memory_search", { query: "anything" });

      expect(Array.isArray(res.content)).toBe(true);
      expect(res.content!.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
