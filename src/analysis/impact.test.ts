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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerImpactAnalysisTool } from "./impact.js";
import { registerAnalysisTools } from "./mcp-tools.js";
import { MemoryStore } from "../memory/store.js";
import { SpecStore } from "../spec/store.js";
import type { SidecarClient } from "../sidecar/client.js";
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
  // M9a: impact_analysis registers via `registerTool` (full strict schema).
  // `registerTool` is generic, so `Parameters<>` collapses to `never`.
  const origRegister = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  server.registerTool = ((...args: unknown[]) => {
    if (typeof args[0] === "string" && typeof args[2] === "function") {
      tools.set(args[0] as string, args[2] as ToolHandler);
    }
    return origRegister(...args);
  }) as typeof server.registerTool;
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

  // --- Task 1b: agent-passable all-or-nothing `reach` param ---

  it("should score an agent-supplied reach and attribute it in the output", async () => {
    // Built-in resolver sees reach 0 for every file here.
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    for (let i = 1; i <= 50; i++) {
      write(tmpDir, `src/u${i}.ts`, `export const u${i} = ${i};\n`);
    }
    restore = stubGit(["src/target.ts"]);

    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/target.ts": 60 },
          source: "module-graph trace",
        },
      })
    ).content[0].text;

    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("reached by 60 modules");
    expect(text).toContain("60% of 100 modules");
    expect(text).toContain("module-graph trace");
    expect(text).toContain("1 of 1");
  });

  it("should rank agent reach above a supplied ReachProvider", async () => {
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    restore = stubGit(["src/target.ts"]);

    const h = captureImpact((s) =>
      registerImpactAnalysisTool(s, null, {
        reachOf: () => 2,
        moduleCount: () => 4,
      }),
    ).get("impact_analysis")!;

    const text = (
      await h({
        project: tmpDir,
        reach: { moduleCount: 100, files: { "src/target.ts": 60 } },
      })
    ).content[0].text;

    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("reached by 60 modules");
    expect(text).not.toContain("reached by 2 modules");
  });

  it("should reject a reach map missing a changed TS file, naming it", async () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    write(tmpDir, "src/b.ts", "export const b = 1;\n");
    restore = stubGit(["src/a.ts", "src/b.ts"]);

    const text = (
      await handler({
        project: tmpDir,
        reach: { moduleCount: 100, files: { "src/a.ts": 60 } },
      })
    ).content[0].text;

    expect(text).toContain("src/b.ts");
    expect(text).toContain("rejected");
    // A rejection, not a generic error and not a silent partial application.
    expect(text).not.toContain("Risk: **");
    expect(text).not.toContain("Error running impact_analysis");
  });

  it("should reject an absolute-path key instead of silently falling back", async () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    restore = stubGit(["src/a.ts"]);

    const absKey = join(tmpDir, "src/a.ts");
    const text = (
      await handler({
        project: tmpDir,
        reach: { moduleCount: 100, files: { [absKey]: 60 } },
      })
    ).content[0].text;

    expect(text).toContain(absKey);
    expect(text).toContain("repo-relative");
    expect(text).not.toContain("Risk: **");
  });

  it("should accept a reach map whose only uncovered file is non-TS", async () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    write(tmpDir, "README.md", "# hi\n");
    restore = stubGit(["src/a.ts", "README.md"]);

    const text = (
      await handler({
        project: tmpDir,
        reach: { moduleCount: 100, files: { "src/a.ts": 60 } },
      })
    ).content[0].text;

    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("reached by 60 modules");
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

// --- Task 8: call sites as evidence in the rendered output ---

/**
 * A reach number says *how much* is coupled; it never says *what*. "89 modules
 * reach this file" gives a reader no thread to pull. Call sites are the
 * evidence, so the section exists to make a HIGH actionable.
 *
 * ⛔ These tests pin two properties that are easy to break together: call sites
 * must never move the verdict (they are evidence, not signal), and inserting
 * the section must leave every later section byte-unchanged — the assertions
 * elsewhere in this file are written against those bytes.
 */
describe("impact_analysis call-site reporting", () => {
  let tmpDir: string;
  let handler: ToolHandler;
  let restore: () => void = () => {};

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-call-sites");
    handler = captureImpact((s) => registerImpactAnalysisTool(s, null)).get(
      "impact_analysis",
    )!;
  });

  afterEach(() => {
    restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One changed file the built-in resolver scores at reach 0, in a 50-module tree. */
  function quietTarget(): void {
    write(tmpDir, "src/target.ts", "export const target = 1;\n");
    for (let i = 1; i <= 50; i++) {
      write(tmpDir, `src/u${i}.ts`, `export const u${i} = ${i};\n`);
    }
    restore = stubGit(["src/target.ts"]);
  }

  function site(over: Partial<Record<string, unknown>> = {}) {
    return {
      file: "src/caller.ts",
      line: 12,
      caller: "doWork",
      callee: "target",
      target: "src/target.ts",
      ...over,
    };
  }

  it("should render call sites as `file:line` with caller and callee", async () => {
    quietTarget();

    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/target.ts": 60 },
          source: "module-graph trace",
          callSites: [
            site(),
            site({ file: "src/other.ts", line: 340, caller: "handle" }),
          ],
        },
      })
    ).content[0].text;

    expect(
      text,
      "reach reported a count with no evidence — nothing to open",
    ).toContain("### Call Sites");
    // `file:line` so an editor/terminal can jump straight to it.
    expect(text).toContain("`src/caller.ts:12`");
    expect(text).toContain("`src/other.ts:340`");
    expect(text).toContain("`doWork`");
    expect(text).toContain("`handle`");
    expect(text).toContain("`target`");
  });

  it("should group call sites under the changed file they are evidence for", async () => {
    write(tmpDir, "src/a.ts", "export const a = 1;\n");
    write(tmpDir, "src/b.ts", "export const b = 1;\n");
    for (let i = 1; i <= 50; i++) {
      write(tmpDir, `src/u${i}.ts`, `export const u${i} = ${i};\n`);
    }
    restore = stubGit(["src/a.ts", "src/b.ts"]);

    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/a.ts": 60, "src/b.ts": 2 },
          callSites: [
            site({ file: "src/x.ts", line: 1, target: "src/a.ts" }),
            site({ file: "src/y.ts", line: 2, target: "src/b.ts" }),
            site({ file: "src/z.ts", line: 3, target: "src/a.ts" }),
          ],
        },
      })
    ).content[0].text;

    const section = text.slice(text.indexOf("### Call Sites"));
    const aHeading = section.indexOf("**`src/a.ts`**");
    const bHeading = section.indexOf("**`src/b.ts`**");
    expect(aHeading).toBeGreaterThan(-1);
    expect(bHeading).toBeGreaterThan(-1);
    // Both of src/a.ts's sites sit under its own heading, before src/b.ts's.
    expect(section.indexOf("`src/x.ts:1`")).toBeGreaterThan(aHeading);
    expect(section.indexOf("`src/z.ts:3`")).toBeGreaterThan(aHeading);
    expect(section.indexOf("`src/z.ts:3`")).toBeLessThan(bHeading);
    expect(section.indexOf("`src/y.ts:2`")).toBeGreaterThan(bHeading);
  });

  it("should render NO section at all when no call sites were supplied", async () => {
    quietTarget();

    const text = (
      await handler({
        project: tmpDir,
        reach: { moduleCount: 100, files: { "src/target.ts": 60 } },
      })
    ).content[0].text;

    expect(
      text,
      "an empty heading is noise — the section must be absent, not empty",
    ).not.toContain("### Call Sites");
    expect(text).not.toContain("Call sites:");
  });

  it("should cap a single file's call sites and state how many were omitted", async () => {
    quietTarget();

    const many = Array.from({ length: 40 }, (_, i) =>
      site({ file: `src/c${i}.ts`, line: i + 1 }),
    );
    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/target.ts": 60 },
          callSites: many,
        },
      })
    ).content[0].text;

    const rendered = text
      .split("\n")
      .filter((l) => /^- `src\/c\d+\.ts:\d+`/.test(l));
    expect(
      rendered.length,
      "a 40-entry dump is no more actionable than a bare count",
    ).toBeLessThan(40);
    expect(rendered.length).toBeGreaterThan(0);
    // The omitted count must be stated, or the section silently lies.
    expect(text).toContain(`…and ${40 - rendered.length} more`);
  });

  it("should cap the number of grouped files and state how many were omitted", async () => {
    quietTarget();

    // 30 distinct targets, one site each.
    const many = Array.from({ length: 30 }, (_, i) =>
      site({ file: `src/c${i}.ts`, line: i + 1, target: `src/t${i}.ts` }),
    );
    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/target.ts": 60 },
          callSites: many,
        },
      })
    ).content[0].text;

    const headings = text
      .split("\n")
      .filter((l) => /^\*\*`src\/t\d+\.ts`\*\*/.test(l));
    expect(headings.length).toBeLessThan(30);
    expect(headings.length).toBeGreaterThan(0);
    expect(text).toMatch(/…and \d+ more call sites across \d+ further/);
  });

  it("should place the section after Import Reach and before File Length Warnings", async () => {
    // 402 lines, so the length warning fires too; reach 60/100 makes the
    // Import Reach block render. All three sections present at once.
    write(tmpDir, "src/big.ts", "// filler\n".repeat(401));
    restore = stubGit(["src/big.ts"]);

    const text = (
      await handler({
        project: tmpDir,
        reach: {
          moduleCount: 100,
          files: { "src/big.ts": 60 },
          callSites: [site({ target: "src/big.ts" })],
        },
      })
    ).content[0].text;

    const reachAt = text.indexOf("### Import Reach");
    const callSitesAt = text.indexOf("### Call Sites");
    const lengthAt = text.indexOf("### File Length Warnings");
    expect(reachAt).toBeGreaterThan(-1);
    expect(lengthAt).toBeGreaterThan(-1);
    expect(callSitesAt).toBeGreaterThan(reachAt);
    expect(callSitesAt).toBeLessThan(lengthAt);
  });

  it("should not change the risk verdict, and must leave every other section byte-identical", async () => {
    quietTarget();

    // 12 of 100 modules: >= MEDIUM_REACH_MIN and >= 10% share, but under the
    // 25% HIGH share — so the verdict is MEDIUM and has room to move either way
    // if call sites ever leaked into `scoreRisk`.
    const reach = { moduleCount: 100, files: { "src/target.ts": 12 } };
    const without = (await handler({ project: tmpDir, reach })).content[0].text;
    const withSites = (
      await handler({
        project: tmpDir,
        reach: {
          ...reach,
          callSites: [site(), site({ file: "src/other.ts", line: 99 })],
        },
      })
    ).content[0].text;

    expect(without).toContain("Risk: **MEDIUM**");
    expect(
      withSites,
      "call sites are evidence, not signal — they must never move the verdict",
    ).toContain("Risk: **MEDIUM**");
    expect(withSites).toContain("### Call Sites");

    // Excise the inserted section; what remains must be byte-identical.
    const stripped = withSites.replace(
      /\n\n### Call Sites\n[\s\S]*?(?=\n\n### )/,
      "",
    );
    expect(
      stripped,
      "inserting the Call Sites section perturbed a later section",
    ).toBe(without);
  });
});

// --- Spec context under the sidecar (the production wiring) ---

/**
 * ⛔ Every test above hands `registerImpactAnalysisTool` a real `SpecStore`.
 * Production never does.
 *
 * `src/mcp/server.ts:43` sets `store = client ? null : ...`, and production
 * always has a client, so `registerAnalysisTools` derives `specStore = null`
 * and the entire spec-compliance half of the tool — `_Active spec:_`, the
 * unexpected-file warning, the Expected/Unexpected summary lines, and one of
 * only two HIGH triggers — was permanently inert. The no-sidecar fallback was
 * the only path with coverage, which is exactly why this shipped broken.
 *
 * These tests construct the tool the way production does: `{client, store: null}`.
 */
describe("impact_analysis spec context under a sidecar client", () => {
  let tmpDir: string;
  let restore: () => void = () => {};

  beforeEach(() => {
    tmpDir = makeTmpDir("impact-client-spec");
  });

  afterEach(() => {
    restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A SidecarClient stub exposing only what the tool is allowed to call. */
  function fakeClient(spec: { title: string; planFile: string } | null) {
    return {
      getCurrentSpec: async () => spec,
    } as unknown as SidecarClient;
  }

  /** Register through the real production entry point, with `store: null`. */
  function productionHandler(client: SidecarClient): ToolHandler {
    return captureImpact((s) =>
      registerAnalysisTools(s, { client, store: null }),
    ).get("impact_analysis")!;
  }

  it("should render the active spec resolved through the client when store is null", async () => {
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1\n\n**Files:**\n- Modify: `src/expected.ts`\n",
    );
    write(tmpDir, "src/expected.ts", "export const e = 1;\n");
    restore = stubGit(["src/expected.ts"]);

    const h = productionHandler(
      fakeClient({
        title: "Sidecar-resolved spec",
        planFile: join(tmpDir, "docs/plans/p.md"),
      }),
    );
    const text = (await h({ project: tmpDir })).content[0].text;

    expect(
      text,
      "the tool never sees the active spec under a sidecar — its entire spec-compliance half is inert in production",
    ).toContain("_Active spec: Sidecar-resolved spec_");
    expect(text).toContain("**Expected (in spec):**");
    expect(text).toContain("- Expected (in spec): 1");
  });

  it("should fire the unexpected-file warning under the client path", async () => {
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1\n\n**Files:**\n- Modify: `src/expected.ts`\n",
    );
    // Nothing imports it and it is far under 400 lines, so `hasUnexpected` is
    // the only signal that can produce HIGH.
    write(tmpDir, "src/rogue.ts", "export const r = 1;\n");
    restore = stubGit(["src/rogue.ts"]);

    const h = productionHandler(
      fakeClient({ title: "P", planFile: join(tmpDir, "docs/plans/p.md") }),
    );
    const text = (await h({ project: tmpDir })).content[0].text;

    expect(text).toContain("not listed in any task's Files section");
    expect(text).toContain("Risk: **HIGH**");
    expect(text).toContain("- Unexpected (not in spec): 1");
  });

  it("should NOT flag a plan's own Test: file as unexpected", async () => {
    // TDD guarantees every task touches its own test file. If `Test:` stays
    // unmatched once the client path works, this warning fires on every task.
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1\n\n**Files:**\n- Modify: `src/thing.ts`\n- Test: `src/thing.test.ts`\n",
    );
    write(tmpDir, "src/thing.ts", "export const t = 1;\n");
    write(tmpDir, "src/thing.test.ts", "// test\n");
    restore = stubGit(["src/thing.ts", "src/thing.test.ts"]);

    const h = productionHandler(
      fakeClient({ title: "P", planFile: join(tmpDir, "docs/plans/p.md") }),
    );
    const text = (await h({ project: tmpDir })).content[0].text;

    expect(
      text,
      "the plan's own Test: file was reported as an unexpected change",
    ).not.toContain("not listed in any task's Files section");
    expect(text).toContain("Risk: **LOW**");
    expect(text).toContain("- Expected (in spec): 2");
  });

  it("should degrade to no-spec output when the client has no active spec", async () => {
    write(tmpDir, "src/quiet.ts", "export const q = 1;\n");
    restore = stubGit(["src/quiet.ts"]);

    const h = productionHandler(fakeClient(null));
    const text = (await h({ project: tmpDir })).content[0].text;

    expect(text).not.toContain("_Active spec:");
    expect(text).toContain("Risk: **LOW**");
  });

  it("should degrade to no-spec output when the sidecar call fails", async () => {
    write(tmpDir, "src/quiet.ts", "export const q = 1;\n");
    restore = stubGit(["src/quiet.ts"]);

    const h = productionHandler({
      getCurrentSpec: async () => {
        throw new Error("sidecar down");
      },
    } as unknown as SidecarClient);
    const text = (await h({ project: tmpDir })).content[0].text;

    expect(text).not.toContain("Error running impact_analysis");
    expect(text).toContain("Risk: **LOW**");
  });
});

// --- The schema an MCP client actually receives ---

/**
 * Every other test in this file — and in `reach.test.ts` — bypasses the
 * zod→JSON-Schema converter: `captureImpact` grabs `args[3]` and calls the
 * handler directly, and the schema tests call `safeParse` on the zod object.
 * So none of them can observe whether `reach` is **advertised** at all.
 *
 * That is the property most likely to regress on a zod or
 * `@modelcontextprotocol/sdk` bump, and the one already known to behave
 * non-obviously through the converter (`.refine()` is silently dropped — see
 * the plan's Implementation Notes). A converter change that emitted `{}` or
 * flattened the nested properties would leave the whole suite green while
 * shipping a parameter no agent can discover.
 *
 * This drives a real `Client` over an in-memory transport so the assertion is
 * against the literal `inputSchema` bytes an MCP client is handed.
 */
describe("impact_analysis advertised inputSchema", () => {
  interface JsonSchemaNode {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    items?: JsonSchemaNode;
    required?: string[];
  }

  async function advertisedInputSchema(): Promise<JsonSchemaNode> {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerImpactAnalysisTool(server, null);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "impact_analysis");
      expect(tool, "impact_analysis is not listed by the server").toBeDefined();
      return tool!.inputSchema as unknown as JsonSchemaNode;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("exposes `reach` as a property, optional, alongside required `project`", async () => {
    const schema = await advertisedInputSchema();

    expect(
      Object.keys(schema.properties ?? {}),
      "`reach` is absent from the advertised inputSchema — no agent can send it.",
    ).toContain("reach");
    expect(schema.required ?? []).toContain("project");
    expect(
      schema.required ?? [],
      "`reach` is advertised as REQUIRED — every reach-less call would fail.",
    ).not.toContain("reach");
  });

  it("advertises both accepted reach shapes", async () => {
    const schema = await advertisedInputSchema();
    const reach = schema.properties?.reach;

    expect(Object.keys(reach?.properties ?? {}).sort()).toEqual([
      "callSites",
      "files",
      "moduleCount",
      "source",
      "sources",
    ]);
    // ⛔ Nothing is REQUIRED at this level, and that is load-bearing: the
    // multi-source form supplies `sources` while the single-source form
    // (which the already-shipped `mcp-servers.md` documents) supplies
    // `moduleCount` + `files`. Marking either group required would advertise
    // one of the two shapes as invalid. Which of them was actually supplied is
    // enforced by `.refine()`, and restated in prose below because the
    // converter drops refinements.
    expect(reach?.required ?? []).toEqual([]);
  });

  it("advertises a per-source universe inside `sources`", async () => {
    const schema = await advertisedInputSchema();
    const source = schema.properties?.reach?.properties?.sources?.items;

    expect(Object.keys(source?.properties ?? {}).sort()).toEqual([
      "files",
      "moduleCount",
      "primary",
      "source",
    ]);
    // Per-source, both are mandatory: a reach map without its own universe is
    // exactly the mis-pairing this shape exists to make impossible.
    expect((source?.required ?? []).sort()).toEqual(["files", "moduleCount"]);
  });

  it("advertises the `<= moduleCount` bound in prose the agent receives", async () => {
    // `.refine()` is inexpressible in JSON Schema and is dropped by the
    // converter, so the bound reaches the agent ONLY via `.describe()`. Without
    // this string an agent on a client that never loads `mcp-servers.md` gets
    // zero pre-flight signal and learns the rule from a failed call.
    const schema = await advertisedInputSchema();
    const files = schema.properties?.reach?.properties?.files;

    expect(files?.description ?? "").toContain("moduleCount");
  });

  /**
   * ⛔ Every constraint the `.refine()` chain enforces must ALSO appear in
   * `.describe()` prose, because the converter drops refinements outright —
   * their messages are only ever seen by an agent that has already made a
   * failing call. This is the assertion that a constraint was not added as a
   * refinement alone.
   */
  it.each([
    ["exactly one source scores", "Exactly one source is scored"],
    ["how the scored source is chosen", "marked `primary`, or the first"],
    ["the others are explicitly unscored", "rendered explicitly as unscored"],
    ["why they cannot be combined", "not commensurable"],
    ["the two shapes are exclusive", "not both, not neither"],
    ["per-source coverage", "All-or-nothing coverage is enforced per source"],
    ["a failing reporting source is dropped", "dropped by name"],
    ["call sites never score", "NEVER scored"],
    ["at most one primary", "at most ONE source"],
    ["per-source universe", "OWN universe"],
  ])("advertises %s in prose the agent receives", async (_label, text) => {
    const schema = await advertisedInputSchema();
    const reach = schema.properties?.reach;
    const prose = [
      reach?.description ?? "",
      ...Object.values(reach?.properties ?? {}).map((p) => p.description ?? ""),
      ...Object.values(reach?.properties?.sources?.items?.properties ?? {}).map(
        (p) => p.description ?? "",
      ),
    ].join("\n");

    expect(prose).toContain(text);
  });
});

// --- M9a: strict top-level schema ---

/**
 * The SDK wraps RAW shapes in a NON-strict object (`zod-compat.ts`
 * `objectFromShape` → `z4mini.object(shape)`), so an agent that forgets the
 * `reach:` wrapper and sends `moduleCount`/`files` at the TOP level had those
 * keys silently stripped: the call succeeded and was scored with the built-in
 * graph — the exact silent-wrong-answer the reach plumbing exists to prevent.
 *
 * These drive a real `Client` because strictness lives in the transport-side
 * validation, which every direct-handler test in this file bypasses.
 */
describe("impact_analysis strict input schema (M9a)", () => {
  async function connected() {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerImpactAnalysisTool(server, null);
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

  it("rejects a mis-nested top-level moduleCount, naming the unknown key", async () => {
    const { client, close } = await connected();
    try {
      const res = await client.callTool({
        name: "impact_analysis",
        arguments: {
          project: "/tmp/nonexistent-project",
          // Forgot the `reach:` wrapper — must be rejected, not silently
          // stripped and scored with the built-in graph.
          moduleCount: 42,
          files: { "src/a.ts": 1 },
        },
      });
      expect(
        res.isError ?? false,
        "mis-nested top-level moduleCount was silently accepted",
      ).toBe(true);
      const text = JSON.stringify(res.content);
      expect(text).toContain("moduleCount");
    } finally {
      await close();
    }
  });

  it("advertises additionalProperties: false so agents see the strictness", async () => {
    const { client, close } = await connected();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "impact_analysis");
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as unknown as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
    } finally {
      await close();
    }
  });

  it("still accepts a correctly nested reach payload through the strict schema", async () => {
    const { client, close } = await connected();
    try {
      const res = await client.callTool({
        name: "impact_analysis",
        arguments: {
          project: "/tmp/nonexistent-project-strict-ok",
          reach: {
            source: "codebase-memory detect_changes",
            moduleCount: 42,
            files: { "src/a.ts": 1 },
          },
        },
      });
      // The project has no git repo — the tool reports an error TEXT but the
      // schema must not reject the call itself with unrecognized_keys.
      const text = JSON.stringify(res.content);
      expect(text).not.toContain("unrecognized_keys");
      expect(text).not.toContain("Unrecognized key");
    } finally {
      await close();
    }
  });
});
