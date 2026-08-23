/**
 * impact_analysis tests
 *
 * These exercise the tool through its **registered MCP handler**, not the
 * internal helpers. The defect this file pins is in the composed result: a
 * helper-level test would pass while the tool stayed wrong.
 *
 * `Bun.spawn` is stubbed for `git` only — every other command falls through to
 * the real implementation, so the importer-counting path under test is the
 * genuine one (the old grep really runs; the new resolver really reads disk).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerImpactAnalysisTool } from "./impact.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import { makeTmpDir, type ToolHandler } from "../test-helpers.js";

// --- Fixture helpers ---

function captureImpact(
  register: (server: McpServer) => void,
): Map<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const tools = new Map<string, ToolHandler>();
  const orig = server.tool.bind(server);
  server.tool = ((...args: unknown[]) => {
    if (args.length >= 4 && typeof args[0] === "string") {
      tools.set(args[0] as string, args[3] as ToolHandler);
    }
    return orig(...(args as Parameters<typeof orig>));
  }) as typeof server.tool;
  register(server);
  return tools;
}

/** Stub `git` (any subcommand) to report `files`; pass everything else through. */
function stubGit(files: string[]): () => void {
  const orig = Bun.spawn;
  (Bun as unknown as { spawn: unknown }).spawn = ((
    cmd: string[],
    opts?: unknown,
  ) => {
    if (Array.isArray(cmd) && cmd[0] === "git") {
      return {
        stdout: { text: async () => files.join("\n") + "\n" },
        stderr: { text: async () => "" },
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }
    return (orig as (...a: unknown[]) => unknown)(cmd, opts);
  }) as typeof Bun.spawn;
  return () => {
    (Bun as unknown as { spawn: unknown }).spawn = orig;
  };
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// --- Task 1: extraction ---

describe("impact.ts extraction", () => {
  it("should register impact_analysis on the server it is given", () => {
    const tools = captureImpact((s) => registerImpactAnalysisTool(s, null));
    expect(tools.has("impact_analysis")).toBe(true);
  });
});

// --- Task 2: regression tests for the risk inversion ---

describe("impact_analysis risk scoring", () => {
  let tmpDir: string;
  let handler: ToolHandler;
  let restore: () => void = () => {};

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-risk");
    handler = captureImpact((s) => registerImpactAnalysisTool(s, null)).get(
      "impact_analysis",
    )!;
  });

  afterEach(() => {
    restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should NOT be HIGH when a file is merely over the 400-line limit", async () => {
    // 402 lines, nothing imports it, no active spec. The only signal is length.
    write(tmpDir, "src/lonely.ts", "// filler\n".repeat(401));
    restore = stubGit(["src/lonely.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    // Length is still REPORTED — it just must not drive the score alone.
    expect(text).toContain("over 400-line limit");
    expect(text).not.toContain("Risk: **HIGH**");
    expect(text).toContain("Risk: **LOW**");
  });

  it("should be HIGH when a changed file has high transitive reach", async () => {
    // target <- hub <- c1..c8  =>  9 transitive importers, but only ONE file
    // contains the string "target" (hub.ts), so grep can only ever see 1.
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    write(
      tmpDir,
      "src/hub.ts",
      'import { target } from "./target.js";\nexport const hub = target;\n',
    );
    for (let i = 1; i <= 8; i++) {
      write(
        tmpDir,
        `src/c${i}.ts`,
        `import { hub } from "./hub.js";\nexport const c${i} = hub;\n`,
      );
    }
    restore = stubGit(["src/target.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).toContain("Risk: **HIGH**");
  });

  it("should NOT count a barrel re-export as an importer", async () => {
    write(tmpDir, "src/target3.ts", "export const t = 1;\n");
    // A re-export: it forwards the symbol, it does not call it.
    write(tmpDir, "src/barrel3.ts", 'export * from "./target3.js";\n');
    // The only genuine importer.
    write(
      tmpDir,
      "src/real3.ts",
      'import { t } from "./target3.js";\nexport const r = t;\n',
    );
    restore = stubGit(["src/target3.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).toContain("1 importer");
    expect(text).not.toContain("2 importers");
  });

  it("should not call the same absolute reach HIGH in a much larger codebase", async () => {
    // Same 9-module reach as the test above, but diluted into a 60-module
    // project. Reach must be judged against the size of the tree it reaches
    // into, or a flat threshold marks most of a real repo HIGH.
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    write(tmpDir, "src/hub.ts", 'import { target } from "./target.js";\n');
    for (let i = 1; i <= 8; i++) {
      write(tmpDir, `src/c${i}.ts`, 'import { hub } from "./hub.js";\n');
    }
    for (let i = 1; i <= 50; i++) {
      write(tmpDir, `src/u${i}.ts`, `export const u${i} = ${i};\n`);
    }
    restore = stubGit(["src/target.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).not.toContain("Risk: **HIGH**");
    expect(text).toContain("Risk: **MEDIUM**");
  });

  // --- Preservation (¬C ⇒ unchanged) ---

  it("should still emit the length warning for a genuinely over-limit file", async () => {
    write(tmpDir, "src/lonely.ts", "// filler\n".repeat(401));
    restore = stubGit(["src/lonely.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).toContain("### File Length Warnings");
    expect(text).toContain(
      "⚠️ **WARNING: `src/lonely.ts` is 402 lines (over 400-line limit)**",
    );
    expect(text).toContain("- Over 400-line limit: 1");
  });

  it("should keep unexpected files as a HIGH trigger", async () => {
    const store = new MemoryStore(join(tmpDir, "test.db"));
    try {
      const specStore = new SpecStore(store);
      write(
        tmpDir,
        "docs/plans/p.md",
        "# p\n\nStatus: IN_PROGRESS\nApproved: Yes\n\n### Task 1\n\n**Files:**\n- Modify: src/expected.ts\n",
      );
      specStore.syncFromPlanFile(join(tmpDir, "docs/plans/p.md"), tmpDir);

      // Nothing imports it and it is well under 400 lines: reach and length
      // are both silent, so only `hasUnexpected` can produce HIGH.
      write(tmpDir, "src/rogue.ts", "export const r = 1;\n");
      restore = stubGit(["src/rogue.ts"]);

      const h = captureImpact((s) =>
        registerImpactAnalysisTool(s, specStore),
      ).get("impact_analysis")!;
      const text = (await h({ project: tmpDir })).content[0].text;

      expect(text).toContain("Risk: **HIGH**");
      expect(text).toContain("not listed in any task's Files section");
    } finally {
      store.close();
    }
  });

  it("should produce byte-identical LOW output for a quiet change", async () => {
    // No spec, nothing imports it, well under 400 lines.
    write(tmpDir, "src/quiet.ts", "export const q = 1;\n");
    restore = stubGit(["src/quiet.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).toBe(
      [
        "## Impact Analysis — Risk: **LOW**",
        "",
        "**1 file changed**",
        "",
        "### Changed Files",
        "",
        "- `src/quiet.ts` — 2 lines",
        "",
        "### Summary",
        "- Risk: **LOW**",
        "- Files changed: 1",
      ].join("\n"),
    );
  });

  // --- Task 4: optional reach-provider seam ---

  it("should behave identically when no reach provider is supplied", async () => {
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    write(tmpDir, "src/hub.ts", 'import { target } from "./target.js";\n');
    for (let i = 1; i <= 8; i++) {
      write(tmpDir, `src/c${i}.ts`, 'import { hub } from "./hub.js";\n');
    }
    restore = stubGit(["src/target.ts"]);

    const noProvider = captureImpact((s) =>
      registerImpactAnalysisTool(s, null),
    ).get("impact_analysis")!;
    // A provider that always defers must be indistinguishable from none.
    const deferring = captureImpact((s) =>
      registerImpactAnalysisTool(s, null, { reachOf: () => null }),
    ).get("impact_analysis")!;

    const a = (await noProvider({ project: tmpDir })).content[0].text;
    const b = (await deferring({ project: tmpDir })).content[0].text;

    expect(a).toBe(b);
    expect(a).toContain("Risk: **HIGH**");
  });

  it("should defer to a reach provider when one is supplied", async () => {
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    for (let i = 1; i <= 50; i++) {
      write(tmpDir, `src/u${i}.ts`, `export const u${i} = ${i};\n`);
    }
    restore = stubGit(["src/target.ts"]);

    // Built-in resolver sees reach 0. The provider knows better.
    const h = captureImpact((s) =>
      registerImpactAnalysisTool(s, null, {
        reachOf: (relPath) => (relPath === "src/target.ts" ? 40 : null),
      }),
    ).get("impact_analysis")!;

    const text = (await h({ project: tmpDir })).content[0].text;

    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("reached by 40 modules");
  });

  it("should fall back to the built-in resolver when a provider throws", async () => {
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    write(tmpDir, "src/hub.ts", 'import { target } from "./target.js";\n');
    for (let i = 1; i <= 8; i++) {
      write(tmpDir, `src/c${i}.ts`, 'import { hub } from "./hub.js";\n');
    }
    restore = stubGit(["src/target.ts"]);

    const h = captureImpact((s) =>
      registerImpactAnalysisTool(s, null, {
        reachOf: () => {
          throw new Error("external graph unavailable");
        },
      }),
    ).get("impact_analysis")!;

    const text = (await h({ project: tmpDir })).content[0].text;

    // Degrades to the built-in answer rather than failing the tool.
    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("reached by 9 modules");
  });

  it("should find a transitive caller with zero textual occurrences of the file", async () => {
    write(tmpDir, "src/target4.ts", "export const t4 = 1;\n");
    write(
      tmpDir,
      "src/mid4.ts",
      'import { t4 } from "./target4.js";\nexport const mid4 = t4;\n',
    );
    // leaf4 reaches target4 through mid4 and contains the string "target4"
    // nowhere at all — grep could never find it.
    write(
      tmpDir,
      "src/leaf4.ts",
      'import { mid4 } from "./mid4.js";\nexport const leaf4 = mid4;\n',
    );
    restore = stubGit(["src/target4.ts"]);

    const text = (await handler({ project: tmpDir })).content[0].text;

    expect(text).toContain("2 importers");
  });
});
