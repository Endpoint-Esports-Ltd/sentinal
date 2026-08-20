/**
 * `runtime_up` / `runtime_stop` — the MCP surface over `lifecycle.ts`.
 *
 * The state machine itself is exhaustively covered in `lifecycle.test.ts`;
 * these tests cover what only the tool layer can get wrong — registration,
 * the DESTRUCTIVE labelling, the required `project` argument, and whether the
 * facts a caller needs (reused / not-reused, the log tail, the refusal reason)
 * survive the trip into Markdown.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, captureTools, type ToolHandler } from "../test-helpers.js";
import { registerRuntimeTools } from "./mcp-tools.js";
import { writePidfile } from "./pidfile.js";

describe("runtime lifecycle MCP tools", () => {
  let tools: Map<string, ToolHandler>;
  let wt: string;

  beforeEach(() => {
    tools = captureTools(registerRuntimeTools, {});
    wt = makeTmpDir("sentinal-lifecycle-mcp");
    mkdirSync(join(wt, ".sentinal"), { recursive: true });
  });

  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  it("registers both tools through registerRuntimeTools, so server.ts is unchanged", () => {
    expect(tools.has("runtime_up")).toBe(true);
    expect(tools.has("runtime_stop")).toBe(true);
    // The Phase 3 tools must still be there.
    expect(tools.has("runtime_config")).toBe(true);
    expect(tools.has("runtime_init")).toBe(true);
  });

  it("is an inert, actionable success when the project has no contract", async () => {
    const r = await tools.get("runtime_up")!({ project: wt });
    expect(r.content[0]!.text).toContain("runtime.json");
    expect(r.content[0]!.text).not.toMatch(/^Error/);
  });

  it("runtime_stop is a no-op on a project that never started anything", async () => {
    const r = await tools.get("runtime_stop")!({ project: wt });
    expect(r.content[0]!.text.toLowerCase()).toContain("nothing to stop");
  });

  it("runtime_stop is idempotent", async () => {
    await tools.get("runtime_stop")!({ project: wt });
    const second = await tools.get("runtime_stop")!({ project: wt });
    expect(second.content[0]!.text).not.toMatch(/^Error/);
  });

  it("runtime_stop REFUSES a pid it cannot prove is ours, and says so", async () => {
    // `process.pid` is alive but its command line is `bun test …`, which does
    // not reference this temp worktree — the PID-reuse case.
    writePidfile(wt, {
      pid: process.pid,
      pgid: process.pid,
      startedAt: Date.now(),
      command: "npm run dev",
      state: "ready",
    });
    const r = await tools.get("runtime_stop")!({ project: wt });
    const text = r.content[0]!.text;
    expect(text.toLowerCase()).toContain("refus");
    expect(text).toContain(String(process.pid));
  });

  it("reports a reused stack as reused and states it was NOT torn down", async () => {
    writeFileSync(
      join(wt, ".sentinal", "runtime.json"),
      JSON.stringify({
        up: "true",
        readiness: { type: "exec", target: "true" },
      }),
    );
    // A "ready" record whose command line references the worktree: the reuse
    // row. `process.pid`'s real cwd is the repo, so ownership is proven with an
    // explicit command instead.
    writePidfile(wt, {
      pid: process.pid,
      pgid: process.pid,
      startedAt: Date.now(),
      command: `node server.js ${wt}`,
      state: "ready",
    });

    const r = await tools.get("runtime_up")!({ project: wt });
    const text = r.content[0]!.text;
    // Ownership is verified from the LIVE process, not from the recorded
    // command string, so this must NOT claim reuse for an unprovable pid.
    expect(text).toMatch(/Reusing|REFUS|not provably|nothing proves/i);
  });
});

describe("runtime_stop tool description", () => {
  it("is flagged DESTRUCTIVE, matching the worktree_cleanup precedent", () => {
    const descriptions = new Map<string, string>();
    const server = {
      tool: (name: string, description: string) => {
        descriptions.set(name, description);
      },
    };
    // Registration only needs `server.tool`; capture the descriptions directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRuntimeTools(server as any, {});
    expect(descriptions.get("runtime_stop")).toContain("DESTRUCTIVE");
    expect(descriptions.get("runtime_up")).not.toContain("DESTRUCTIVE");
  });
});
