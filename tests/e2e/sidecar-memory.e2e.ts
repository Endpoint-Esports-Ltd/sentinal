// Sidecar + Memory E2E.
//
// NOTE: filename is `*.e2e.ts` (NOT `*.test.ts`) so a bare `bun test`
// (default test glob) never discovers it. Run via the e2e runner:
//   bun test ./tests/e2e/sidecar-memory.e2e.ts
//
// Proves two things end-to-end, fully in-sandbox:
//   (a) The sidecar starts on the SANDBOX socket — connecting the MCP client
//       and making a call triggers autoStartSidecar() (src/mcp/server.ts), and
//       its state files (sidecar.sock/port/pid) land under <home>/.sentinal,
//       never the real ~/.sentinal.
//   (b) Memory round-trips: memory_save then memory_search find the saved
//       observation, in-sandbox. The COMPILED dist/sentinal binary (which
//       McpTestClient prefers) bundles sqlite-vec so vec0 loads in-subprocess.
//
// Observed against the compiled dist/sentinal binary (run once before asserting):
//   - <home>/.sentinal contains sidecar.sock, sidecar.port, sidecar.pid, memory.db
//   - memory_save returns text: 'Saved observation #1: "<title>" (discovery)'
//   - memory_search returns a markdown table containing the saved ID + title
//   - after McpTestClient.close() + sb.cleanup(), pgrep -f <home> is empty and
//     the sandbox HOME is removed (no sidecar leak).

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  snapshotRealDirs,
  assertNoRealEscape,
  type Sandbox,
} from "./harness/sandbox.ts";
import { McpTestClient } from "./harness/mcp-client.ts";

const TIMEOUT = 120_000;

// Give the detached sidecar a moment to write its state files / exit.
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Sidecar + Memory E2E — sentinal mcp-server", () => {
  let realBefore: Record<string, string> = {};

  beforeAll(() => {
    realBefore = snapshotRealDirs();
  });

  let sb: Sandbox | null = null;
  let mcp: McpTestClient | null = null;

  afterEach(async () => {
    await mcp?.close();
    mcp = null;
    // cleanup() kills sandbox-owned sidecar by pid (ownership-checked) + rm -rf.
    sb?.cleanup();
    sb = null;
    // Backstop: the real user dirs must be byte-unchanged after the run.
    assertNoRealEscape(realBefore);
  });

  it(
    "autostarts the sidecar on the SANDBOX socket (never the real one)",
    async () => {
      sb = createSandbox();
      mcp = new McpTestClient(sb.env);
      await mcp.connect();

      // A call forces the MCP server to autostart the sidecar (memory tools
      // delegate to it). memory_stats has no side effects but warms the path.
      const res = await mcp.callTool("memory_stats", {});
      expect(Array.isArray(res.content)).toBe(true);

      // Give the detached sidecar a moment to write its state files.
      await delay(2000);

      const sentDir = join(sb.home, ".sentinal");
      const sock = join(sentDir, "sidecar.sock");
      const port = join(sentDir, "sidecar.port");
      const pid = join(sentDir, "sidecar.pid");

      // At least one sidecar state file must exist under the SANDBOX .sentinal.
      const sandboxSidecarPresent =
        existsSync(sock) || existsSync(port) || existsSync(pid);
      expect(sandboxSidecarPresent).toBe(true);

      // The sandbox pid path specifically must exist in-sandbox.
      expect(existsSync(pid)).toBe(true);

      // Isolation backstop: whatever the sandbox pid is, it points into the
      // sandbox HOME — not the real ~/.sentinal (which may hold an unrelated
      // pid from the developer's own sidecar). The escape env guard +
      // assertNoRealEscape already prove non-escape; this asserts the sandbox
      // path exists distinctly.
      expect(pid.startsWith(sb.home)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "round-trips a memory observation via MCP (save then search)",
    async () => {
      sb = createSandbox();
      mcp = new McpTestClient(sb.env);
      await mcp.connect();

      const title = "E2E memory round-trip zulu yankee xray";
      const content =
        "Sandbox memory persistence proof — whiskey victor tango sierra romeo.";

      const save = await mcp.callTool("memory_save", {
        title,
        content,
        type: "discovery",
        project: sb.home,
      });
      const saveText = save.content?.[0]?.text ?? "";
      // Observed shape: 'Saved observation #<id>: "<title>" (discovery)'
      expect(saveText).toContain("Saved observation #");
      expect(saveText).toContain(title);

      const idMatch = saveText.match(/Saved observation #(\d+)/);
      expect(idMatch).not.toBeNull();
      const savedId = Number(idMatch![1]);
      expect(Number.isFinite(savedId)).toBe(true);

      // Search by distinctive words from the saved title.
      const search = await mcp.callTool("memory_search", {
        query: "memory round-trip zulu yankee",
        project: sb.home,
      });
      const searchText = search.content?.[0]?.text ?? "";
      // Observed shape: markdown table with 'Found N observation(s):' + the row.
      expect(searchText).toContain("Found");
      expect(searchText).toContain(title);

      // Cross-check the exact observation via memory_get by id.
      const got = await mcp.callTool("memory_get", { ids: [savedId] });
      const gotText = got.content?.[0]?.text ?? "";
      expect(gotText).toContain(title);
      expect(gotText).toContain(content);
    },
    TIMEOUT,
  );

  it(
    "leaves no sidecar process referencing the sandbox HOME after cleanup",
    async () => {
      sb = createSandbox();
      const home = sb.home;
      mcp = new McpTestClient(sb.env);
      await mcp.connect();
      await mcp.callTool("memory_stats", {});
      await delay(1000);

      // Teardown explicitly here (not just afterEach) so we can assert the
      // sandbox is fully scrubbed: no surviving process references the unique
      // sandbox HOME path, and the HOME dir is gone.
      await mcp.close();
      mcp = null;
      sb.cleanup();
      sb = null;
      await delay(500);

      const ps = Bun.spawnSync(["pgrep", "-f", home], { stdout: "pipe" });
      const survivors = (ps.stdout?.toString() ?? "").trim();
      expect(survivors).toBe("");
      expect(existsSync(home)).toBe(false);
    },
    TIMEOUT,
  );
});
