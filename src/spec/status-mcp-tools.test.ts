/**
 * Spec Status MCP Tools — project identity tests
 *
 * `spec_status` and `spec_init` take the SAME `project` parameter name but mean
 * two DIFFERENT things by it, and this file pins both halves of that split:
 *
 *   - `spec_status` → a STORAGE KEY. It queries `specs.project_path` with exact
 *     SQL equality (`SpecStore.getCurrentSpec`). Wave 3 made every write
 *     canonical, so a caller standing in a linked worktree matched nothing —
 *     the "No active spec found" half of the originally-reported bug.
 *
 *   - `spec_init` → a FILESYSTEM SEARCH ROOT. It scans `<project>/docs/plans/`
 *     via `findActivePlan`. That worktree-locality is a DELIBERATE design
 *     decision (docs/plans/2026-06-10-multi-plan-session-tracking.md:60-66) and
 *     must survive this change untouched.
 *
 * Fixtures are REAL git repos with REAL linked worktrees: a fake path proves
 * nothing, because `resolveProjectIdentity("/test")` returns `/test` unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "./store.js";
import { registerSpecStatusTools } from "./status-mcp-tools.js";
import { makeTmpDir, type ToolHandler } from "../test-helpers.js";

/**
 * `registerSpecStatusTools` takes positional `(server, client, specStore)`
 * rather than the `(server, deps)` shape `captureTools` expects, so the capture
 * is inlined here instead of being bent through a wrapper.
 */
function captureStatusTools(specStore: SpecStore): Map<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, ToolHandler>();
  const origTool = server.tool.bind(server);
  server.tool = ((...args: unknown[]) => {
    if (args.length >= 4 && typeof args[0] === "string") {
      tools.set(args[0] as string, args[3] as ToolHandler);
    }
    return origTool(...(args as Parameters<typeof origTool>));
  }) as typeof server.tool;

  registerSpecStatusTools(server, null, specStore);
  return tools;
}

function makePlanFile(dir: string, slug: string, title: string): string {
  const plansDir = join(dir, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${slug}.md`);
  writeFileSync(
    planFile,
    `# ${title}

Status: IN_PROGRESS
Type: Feature
Approved: Yes

## Progress Tracking

- [ ] Task 1: First task

**Total Tasks:** 1 | **Completed:** 0 | **Remaining:** 1

## Implementation Tasks

### Task 1: First task

**Objective:** Do the first thing.
`,
  );
  return planFile;
}

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir });
}

describe("spec status tools project identity", () => {
  let tmpDir: string;
  let repoDir: string;
  let wtPath: string;
  let store: MemoryStore;
  let specStore: SpecStore;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    // realpathSync pre-applied: /var symlinks to /private/var on macOS and
    // resolveProjectIdentity canonicalizes, so raw tmp paths never compare equal.
    tmpDir = realpathSync(makeTmpDir());
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initRepo(repoDir);
    wtPath = join(tmpDir, "wt-feature");
    Bun.spawnSync(["git", "worktree", "add", wtPath, "-b", "feature"], {
      cwd: repoDir,
    });

    store = new MemoryStore(join(tmpDir, "spec.db"));
    specStore = new SpecStore(store);
    tools = captureStatusTools(specStore);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- spec_status: STORAGE KEY ---

  it("spec_status with a worktree path finds the canonically-keyed spec", async () => {
    const planFile = makePlanFile(wtPath, "2026-09-23-wt-plan", "WT Plan");
    // Registered canonically, exactly as Wave 3's write path does it.
    specStore.syncFromPlanFile(planFile, repoDir);

    const result = await tools.get("spec_status")!({ project: wtPath });

    expect(result.content[0].text).toContain("2026-09-23-wt-plan");
    expect(result.content[0].text).not.toContain("No active spec found");
  }, 20_000);

  it("spec_status still reports nothing for an UNRELATED project", async () => {
    const planFile = makePlanFile(wtPath, "2026-09-23-wt-plan", "WT Plan");
    specStore.syncFromPlanFile(planFile, repoDir);

    const result = await tools.get("spec_status")!({
      project: "/some/other/project",
    });

    expect(result.content[0].text).toContain("No active spec found");
  }, 20_000);

  // --- spec_init: FILESYSTEM SEARCH ROOT (must stay worktree-local) ---

  it("spec_init STILL resolves plans from the worktree's own docs/plans/", async () => {
    // Two DIFFERENT plans: one in the main checkout, one in the worktree.
    // If `project` were canonicalized here, spec_init would surface the main
    // checkout's plan and the worktree's own work would become invisible.
    makePlanFile(repoDir, "2026-09-23-main-plan", "Main Checkout Plan");
    makePlanFile(wtPath, "2026-09-23-worktree-plan", "Worktree Local Plan");

    const result = await tools.get("spec_init")!({ project: wtPath });
    const text = result.content[0].text;

    expect(text).toContain("Worktree Local Plan");
    expect(text).not.toContain("Main Checkout Plan");
    expect(text).toContain(join(wtPath, "docs", "plans"));
  }, 20_000);

  it("spec_init reports no active plan when the worktree has no docs/plans/", async () => {
    makePlanFile(repoDir, "2026-09-23-main-plan", "Main Checkout Plan");

    const result = await tools.get("spec_init")!({ project: wtPath });

    expect(result.content[0].text).toContain("No active plan found");
  }, 20_000);
});
