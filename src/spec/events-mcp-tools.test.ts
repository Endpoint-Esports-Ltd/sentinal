/**
 * spec_notify carries a project (hardening sweep Task 14 / D5).
 *
 * A warning created by an agent must reach THAT project's session-start
 * digest, so the row needs the canonical project key and a `source`. The tool
 * takes an optional `project`, defaulting to the identity of the MCP server's
 * cwd. The shipped prose payload (`type`, `title`, `message`, `spec_id`) stays
 * valid — `project` is optional.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";
import { registerSpecTools } from "./mcp-tools.js";
import type { SidecarClient } from "../sidecar/client.js";
import { resolveProjectIdentity } from "../project/identity.js";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";

describe("spec_notify — project scoping (direct store)", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "test.db"));
    tools = captureTools(registerSpecTools, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores a supplied project as its canonical identity, with source spec-notify", async () => {
    // Un-realpath'd tmp dir + trailing slash: a non-canonical spelling.
    await tools.get("spec_notify")!({
      type: "warning",
      title: "Verification blocked",
      project: tmpDir + "/",
    });
    const [row] = store.getNotifications({ limit: 10 });
    expect(row!.projectPath).toBe(realpathSync(tmpDir));
    expect(row!.source).toBe("spec-notify");
  });

  it("defaults the project to the identity of the process cwd", async () => {
    await tools.get("spec_notify")!({ type: "info", title: "No project" });
    const [row] = store.getNotifications({ limit: 10 });
    expect(row!.projectPath).toBe(resolveProjectIdentity(process.cwd()));
  });

  it("the project disambiguates a slug shared by two projects' plans", async () => {
    const slug = "2026-01-01-shared";
    const dirs = [join(tmpDir, "a"), join(tmpDir, "b")];
    const specStore = new SpecStore(store);
    for (const dir of dirs) {
      mkdirSync(join(dir, "docs", "plans"), { recursive: true });
      const plan = join(dir, "docs", "plans", `${slug}.md`);
      writeFileSync(plan, "# P\n\nStatus: PENDING\nApproved: Yes\n");
      specStore.syncFromPlanFile(plan, dir);
    }
    const keyOf = (dir: string) =>
      (
        store
          .getRawDb()
          .prepare("SELECT id FROM specs WHERE project_path = ?")
          .get(realpathSync(dir)) as { id: string }
      ).id;

    await tools.get("spec_notify")!({
      type: "warning",
      title: "B's plan",
      spec_id: slug,
      project: dirs[1],
    });
    const [row] = store.getNotifications({ limit: 10 });
    expect(row!.specId).toBe(keyOf(dirs[1]!));
    expect(row!.specId).not.toBe(keyOf(dirs[0]!));
  });
});

describe("spec_notify — project scoping (sidecar client)", () => {
  function capture() {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      insertNotification: async (n: Record<string, unknown>) => {
        calls.push(n);
      },
    } as unknown as SidecarClient;
    return { calls, tools: captureTools(registerSpecTools, { client }) };
  }

  it("sends the canonical projectPath and source", async () => {
    const dir = makeTmpDir();
    try {
      const { calls, tools } = capture();
      await tools.get("spec_notify")!({
        type: "warning",
        title: "t",
        project: dir,
      });
      expect(calls[0]!.projectPath).toBe(realpathSync(dir));
      expect(calls[0]!.source).toBe("spec-notify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the shipped prose payload (no project) and defaults to the cwd identity", async () => {
    const { calls, tools } = capture();
    const res = await tools.get("spec_notify")!({
      type: "info",
      title: "Verification complete",
      message: "All checks passed",
      spec_id: "2026-01-01-x",
    });
    expect(res.content[0]!.text).toContain("Notification created");
    expect(calls[0]!.projectPath).toBe(resolveProjectIdentity(process.cwd()));
  });
});
