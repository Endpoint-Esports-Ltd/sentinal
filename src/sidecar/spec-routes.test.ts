/**
 * Spec Sidecar Routes Tests
 *
 * Tests for the spec sidecar route handler:
 *   - GET /spec/metrics — spec + task timing for spec_metrics (H2)
 *
 * Includes the production-shape regression for H2: `spec_metrics` registered
 * via the PRODUCTION entry point (`registerSpecTools(server, {client, store:
 * null})`), driven by a real MCP `Client` over `InMemoryTransport`, against a
 * real sidecar. Before the fix this configuration always returned
 * "No spec found." because the tool required a direct `specStore` that is
 * always null in sidecar mode.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import { SpecStore } from "../spec/store.js";
import { WorktreeStore } from "../worktree/store.js";
import { registerSpecTools } from "../spec/mcp-tools.js";
import { startSidecar, stopSidecar } from "./server.js";
import type { SidecarContext } from "./server.js";
import { SidecarClient } from "./client.js";
import { handleSpecMetricsRequest } from "./spec-routes.js";
import type { SpecMetricsData } from "./spec-routes.js";
import { makeTmpDir } from "../test-helpers.js";

function makePlanFile(
  dir: string,
  slug: string,
  status = "IN_PROGRESS",
): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${slug}.md`);
  writeFileSync(
    planFile,
    `# Test Plan

Status: ${status}
Type: Feature
Approved: Yes

## Progress Tracking

- [ ] Task 1: First task
- [ ] Task 2: Second task

**Total Tasks:** 2 | **Completed:** 0 | **Remaining:** 2

## Implementation Tasks

### Task 1: First task

**Objective:** Do the first thing.

### Task 2: Second task

**Objective:** Do the second thing.
`,
  );
  return planFile;
}

function makeCtx(store: MemoryStore): SidecarContext {
  return {
    store,
    service: new MemoryService(store),
    specStore: new SpecStore(store),
    wtStore: new WorktreeStore(store),
    httpPort: 0,
  };
}

// ─── Route handler unit tests ───────────────────────────────────────────────

describe("spec-routes: GET /spec/metrics", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let ctx: SidecarContext;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    ctx = makeCtx(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-matching paths", async () => {
    const req = new Request("http://localhost/other-path", { method: "GET" });
    const res = await handleSpecMetricsRequest(req, ctx);
    expect(res).toBeNull();
  });

  it("returns null for non-GET methods on the same path", async () => {
    const req = new Request("http://localhost/spec/metrics", {
      method: "POST",
    });
    const res = await handleSpecMetricsRequest(req, ctx);
    expect(res).toBeNull();
  });

  it("returns 400 when spec_id is missing", async () => {
    const req = new Request("http://localhost/spec/metrics", { method: "GET" });
    const res = await handleSpecMetricsRequest(req, ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("returns null spec and empty tasks for an unknown spec", async () => {
    const req = new Request("http://localhost/spec/metrics?spec_id=nope", {
      method: "GET",
    });
    const res = await handleSpecMetricsRequest(req, ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as { ok: boolean; data: SpecMetricsData };
    expect(body.ok).toBe(true);
    expect(body.data.spec).toBeNull();
    expect(body.data.tasks).toEqual([]);
  });

  it("returns spec + task timing for a registered spec", async () => {
    const slug = "2026-09-01-metrics-route";
    const planFile = makePlanFile(tmpDir, slug);
    ctx.specStore.syncFromPlanFile(planFile, tmpDir, "test-session");

    const now = Date.now();
    store
      .getRawDb()
      .run("UPDATE specs SET started_at = ? WHERE id = ?", [
        now - 3600000,
        slug,
      ]);
    store
      .getRawDb()
      .run(
        "UPDATE spec_tasks SET started_at = ?, completed_at = ? WHERE spec_id = ? AND position = 1",
        [now - 900000, now - 300000, slug],
      );

    const req = new Request(
      `http://localhost/spec/metrics?spec_id=${encodeURIComponent(slug)}`,
      { method: "GET" },
    );
    const res = await handleSpecMetricsRequest(req, ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as { ok: boolean; data: SpecMetricsData };
    expect(body.ok).toBe(true);
    expect(body.data.spec).not.toBeNull();
    expect(body.data.spec!.title).toBe("Test Plan");
    expect(body.data.spec!.startedAt).toBe(now - 3600000);
    expect(body.data.spec!.completedAt).toBeNull();
    expect(body.data.tasks).toHaveLength(2);
    expect(body.data.tasks[0].position).toBe(1);
    expect(body.data.tasks[0].title).toBe("First task");
    expect(body.data.tasks[0].startedAt).toBe(now - 900000);
    expect(body.data.tasks[0].completedAt).toBe(now - 300000);
    expect(body.data.tasks[1].startedAt).toBeNull();
  });
});

// ─── Client round-trip + production-shape regression (H2) ───────────────────

describe("spec_metrics in the production (sidecar) configuration", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  let client: SidecarClient;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    sidecar = await startSidecar({
      store,
      httpOnly: true,
      port: 0,
      enableVectorSearch: false,
    });
    const port = (sidecar.server as unknown as { port: number }).port;
    client = (
      SidecarClient as unknown as {
        buildForTest: (url: string) => SidecarClient;
      }
    ).buildForTest(`http://127.0.0.1:${port}`);
  });

  afterEach(() => {
    stopSidecar(sidecar.server, sidecar.ctx);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("client.getSpecMetrics round-trips spec + task timing", async () => {
    const slug = "2026-09-01-client-roundtrip";
    const planFile = makePlanFile(tmpDir, slug);
    await client.syncSpec(planFile, tmpDir);

    const now = Date.now();
    store
      .getRawDb()
      .run("UPDATE specs SET started_at = ? WHERE id = ?", [
        now - 1800000,
        slug,
      ]);

    const data = await client.getSpecMetrics(slug);
    expect(data.spec).not.toBeNull();
    expect(data.spec!.title).toBe("Test Plan");
    expect(data.spec!.startedAt).toBe(now - 1800000);
    expect(data.tasks).toHaveLength(2);
  });

  it("spec_metrics returns real timing with {client, store: null} (H2 regression)", async () => {
    // Register a spec through the sidecar harness (the /spec/sync route)
    const slug = "2026-09-01-h2-regression";
    const planFile = makePlanFile(tmpDir, slug);
    await client.syncSpec(planFile, tmpDir);

    const now = Date.now();
    store
      .getRawDb()
      .run("UPDATE specs SET started_at = ? WHERE id = ?", [
        now - 3600000,
        slug,
      ]);
    store
      .getRawDb()
      .run(
        "UPDATE spec_tasks SET started_at = ?, completed_at = ? WHERE spec_id = ? AND position = 1",
        [now - 900000, now - 300000, slug],
      );

    // PRODUCTION entry point + production deps shape: sidecar client, no store
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerSpecTools(server, { client, store: null });

    const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      mcpClient.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const result = (await mcpClient.callTool({
        name: "spec_metrics",
        arguments: { project: tmpDir, spec_id: slug },
      })) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      expect(text).not.toContain("No spec found.");
      expect(text).toContain("Spec Metrics: Test Plan");
      expect(text).toContain("Plan Timing");
      expect(text).toContain("Task Timing");
      expect(text).toContain("First task");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
