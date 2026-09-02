/**
 * memory_maintain registration + client-mode tests (M6b of
 * docs/plans/2026-09-02-audit-medium-remediation.md, Truth 10).
 *
 * The bug: `registerMemoryTools` only registered `memory_maintain` when a
 * direct `store` was provided — in production sidecar mode
 * (`{ client, store: null }`, the shape `src/mcp/server.ts` passes) the tool
 * documented in the README/catalog simply did not exist.
 *
 * Uses a real `Client` over `InMemoryTransport` (precedent:
 * `src/utils/schema.test.ts`) so the assertion covers the actual MCP
 * listTools surface, not a captured registration map.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryStore, getDbPath } from "./store.js";
import { MemoryService } from "./service.js";
import { registerMemoryTools } from "./mcp-tools.js";
import { SidecarClient } from "../sidecar/client.js";

interface ConnectedServer {
  client: Client;
  close: () => Promise<void>;
}

async function connect(server: McpServer): Promise<ConnectedServer> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The production sidecar-mode deps shape (`src/mcp/server.ts:50`). */
function buildSidecarModeServer(): McpServer {
  const server = new McpServer({ name: "test-sentinal", version: "0.0.1" });
  const sidecarClient = SidecarClient.buildForTest("http://127.0.0.1:1");
  registerMemoryTools(server, { client: sidecarClient, store: null });
  return server;
}

describe("memory_maintain registration (M6b / Truth 10)", () => {
  let savedHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    // Isolate getDbPath() from the run-wide shared SENTINAL_HOME so the
    // client-mode handler's scoped MemoryStore cannot touch other tests' data.
    savedHome = process.env.SENTINAL_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "sentinal-maintain-test-"));
    process.env.SENTINAL_HOME = tempHome;
  });

  afterEach(() => {
    process.env.SENTINAL_HOME = savedHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("lists memory_maintain in sidecar mode ({ client, store: null })", async () => {
    const { client, close } = await connect(buildSidecarModeServer());
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("memory_maintain");
    } finally {
      await close();
    }
  });

  it("flags the tool DESTRUCTIVE in its description (repo rule)", async () => {
    const { client, close } = await connect(buildSidecarModeServer());
    try {
      const { tools } = await client.listTools();
      const maintain = tools.find((t) => t.name === "memory_maintain");
      expect(maintain).toBeDefined();
      expect(maintain!.description).toContain("DESTRUCTIVE");
    } finally {
      await close();
    }
  });

  it("client-mode prune opens a scoped store on the sidecar's DB and works while the sidecar holds it open (WAL)", async () => {
    // Simulate the sidecar: a long-lived WAL connection to getDbPath(),
    // held open across the tool call.
    const sidecarStore = new MemoryStore();
    expect(sidecarStore).toBeDefined();
    const sidecarService = new MemoryService(sidecarStore);
    try {
      const doomed = sidecarService.addObservation({
        sessionId: "s",
        projectPath: "/p",
        timestamp: Date.now(),
        type: "error",
        title: "low quality",
        content: "c",
        filePaths: [],
        tags: [],
        metadata: {},
      });
      sidecarStore
        .getRawDb()
        .prepare("UPDATE observations SET quality_score = 0.01 WHERE id = ?")
        .run(doomed.id);

      const { client, close } = await connect(buildSidecarModeServer());
      try {
        // Concurrent open+write from a second connection while the first is
        // open — WAL must allow this.
        const result = (await client.callTool({
          name: "memory_maintain",
          arguments: { action: "prune" },
        })) as { content: Array<{ type: string; text: string }> };
        expect(result.content[0].text).toContain("Pruned 1");
      } finally {
        await close();
      }

      // The sidecar connection sees the deletion...
      expect(sidecarStore.getObservation(doomed.id)).toBeNull();
      // ...and can still write afterwards (no lock left behind by the
      // scoped per-call store).
      const after = sidecarService.addObservation({
        sessionId: "s",
        projectPath: "/p",
        timestamp: Date.now(),
        type: "discovery",
        title: "post-maintain write",
        content: "c",
        filePaths: [],
        tags: [],
        metadata: {},
      });
      expect(after.id).toBeGreaterThan(0);
    } finally {
      sidecarStore.close();
    }
  });

  it("dry_run prune in client mode previews without deleting", async () => {
    const sidecarStore = new MemoryStore();
    const sidecarService = new MemoryService(sidecarStore);
    try {
      const obs = sidecarService.addObservation({
        sessionId: "s",
        projectPath: "/p",
        timestamp: Date.now(),
        type: "error",
        title: "low quality",
        content: "c",
        filePaths: [],
        tags: [],
        metadata: {},
      });
      sidecarStore
        .getRawDb()
        .prepare("UPDATE observations SET quality_score = 0.01 WHERE id = ?")
        .run(obs.id);

      const { client, close } = await connect(buildSidecarModeServer());
      try {
        const result = (await client.callTool({
          name: "memory_maintain",
          arguments: { action: "prune", dry_run: true },
        })) as { content: Array<{ type: string; text: string }> };
        expect(result.content[0].text).toContain("[DRY RUN]");
      } finally {
        await close();
      }
      expect(sidecarStore.getObservation(obs.id)).not.toBeNull();
    } finally {
      sidecarStore.close();
    }
  });

  it("still registers and works in direct-store mode (regression)", async () => {
    const store = new MemoryStore(join(tempHome, "direct.db"));
    try {
      const server = new McpServer({ name: "t", version: "0.0.1" });
      registerMemoryTools(server, { store });
      const { client, close } = await connect(server);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("memory_maintain");
        const result = (await client.callTool({
          name: "memory_maintain",
          arguments: { action: "stats" },
        })) as { content: Array<{ type: string; text: string }> };
        expect(result.content[0].text).toContain("Quality Score Distribution");
      } finally {
        await close();
      }
    } finally {
      store.close();
    }
  });

  it("getDbPath resolves under the isolated home (sanity for the scoped open)", () => {
    expect(getDbPath()).toBe(join(tempHome, "memory.db"));
  });
});
