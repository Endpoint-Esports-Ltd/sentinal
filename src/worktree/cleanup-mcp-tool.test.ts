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
import { captureTools } from "../test-helpers.js";
import { registerWorktreeTools } from "./mcp-tools.js";
import { registerWorktreeCleanupTool } from "./cleanup-mcp-tool.js";

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
