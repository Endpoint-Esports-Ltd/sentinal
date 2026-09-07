/**
 * `worktree_cleanup`'s own module.
 *
 * ⛔ The behavioural coverage for this tool (guard-3 threading on both paths,
 * guard-5 warning surfacing, the `process.cwd()` default) lives in
 * `mcp-tools.test.ts`, driven through `registerWorktreeTools` — that is the
 * seam production uses, and moving those tests here would only assert the
 * private function instead of the registration chain.
 *
 * What this file adds is the guarantee the split itself could break: that the
 * extraction is still wired in, and that a module whose whole job is deleting
 * directories has not quietly acquired a dependency on `src/runtime/` (the
 * no-module-cycle guard would catch it too, but a failure here names the reason
 * rather than the rule).
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureTools, makeTmpDir } from "../test-helpers.js";
import { registerWorktreeTools } from "./mcp-tools.js";
import { registerWorktreeCleanupTool } from "./cleanup-mcp-tool.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryStore } from "../memory/store.js";
import { WorktreeManager } from "./manager.js";
import { DEFAULT_WORKTREE_CONFIG } from "./types.js";
import { WorktreeStore } from "./store.js";

/**
 * Capture the raw zod SHAPE each tool registers, so assertions bind to the
 * real schema rather than to the module's source text.
 */
function captureSchemas(
  register: (
    s: McpServer,
    c: null,
    m: WorktreeManager,
    st: MemoryStore,
  ) => void,
): Map<string, Record<string, { description?: string }>> {
  const shapes = new Map<string, Record<string, { description?: string }>>();
  const server = {
    tool: (name: string, _desc: string, shape: unknown) => {
      shapes.set(name, shape as Record<string, { description?: string }>);
    },
  } as unknown as McpServer;

  const tmp = makeTmpDir();
  const store = new MemoryStore(join(tmp, "schema.db"));
  try {
    const manager = new WorktreeManager(
      new WorktreeStore(store),
      DEFAULT_WORKTREE_CONFIG,
    );
    register(server, null, manager, store);
  } finally {
    store.close();
  }
  return shapes;
}

describe("worktree_cleanup module split", () => {
  it("exports the registrar", () => {
    expect(typeof registerWorktreeCleanupTool).toBe("function");
  });

  it("is still registered through registerWorktreeTools", () => {
    // The extraction is only safe if the chain is intact. `null` deps take the
    // backwards-compat path and register every tool.
    const tools = captureTools(registerWorktreeTools, null);
    expect(tools.has("worktree_cleanup")).toBe(true);
  });

  it("mcp-tools.ts delegates rather than keeping a second copy", () => {
    const text = readFileSync(join(import.meta.dir, "mcp-tools.ts"), "utf-8");
    expect(text).toContain("registerWorktreeCleanupTool");
    // A duplicated registration would shadow or double-register the tool.
    expect(text).not.toContain('"worktree_cleanup"');
  });

  // ── Idempotency key on the agent-facing schema (issue #9) ───────────────
  //
  // ⛔ Bound to the REGISTERED ZOD SHAPE, not to the source text. A
  // `readFileSync(...).includes("idempotency_key")` check would pass on a
  // comment or an error-message builder and could not fail for its own reason
  // (see .claude/skills/sentinal-schema-prose-drift).
  it("exposes idempotency_key on worktree_cleanup's schema", () => {
    const schemas = captureSchemas(registerWorktreeCleanupTool);
    const shape = schemas.get("worktree_cleanup")!;
    expect(shape).toBeDefined();
    expect(Object.keys(shape)).toContain("idempotency_key");
  });

  it("documents the retry-safety constraint in describe() text, which ships", () => {
    // JSON-Schema conversion DROPS .refine(); only .describe() reaches the
    // agent. A constraint the agent cannot see is not a contract.
    const shape = captureSchemas(registerWorktreeCleanupTool).get(
      "worktree_cleanup",
    )!;
    const described = (
      shape.idempotency_key as { description?: string }
    ).description?.toLowerCase();
    expect(described).toBeTruthy();
    expect(described).toContain("retry");
  });

  it("imports nothing from src/runtime/", () => {
    const text = readFileSync(
      join(import.meta.dir, "cleanup-mcp-tool.ts"),
      "utf-8",
    );
    const specifiers = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.filter((s) => s.includes("runtime/"))).toEqual([]);
  });
});
