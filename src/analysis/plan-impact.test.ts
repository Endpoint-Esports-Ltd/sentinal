/**
 * plan_impact tests
 *
 * `impact_analysis` is diff-driven (`git diff --name-only HEAD`), so during
 * planning — before a single edit exists — it reports "0 files changed" and is
 * inherently post-hoc. `plan_impact` is the prospective counterpart.
 *
 * ⛔ D4 — the two halves are tested to DIFFERENT standards on purpose:
 *
 *   - **Overlap detection** is asserted exactly, including with **zero**
 *     injected sources and no code-graph tool, because it is a deterministic
 *     property of the plan text.
 *   - **Prospective reach** is asserted only for attribution and for the
 *     presence of its assumption inline in the output, because it is bounded
 *     by how accurate the plan's `Files:` prediction turns out to be.
 *
 * A test that asserted both to the same standard would misrepresent the tool.
 *
 * `plan-impact-report.ts` (the rendering split off for length, as
 * `reach-sources.ts` was from `reach.ts`) has no separate test file and needs
 * none: every assertion below runs through the registered MCP handler, so the
 * composed output is what is pinned. A helper-level test could pass while the
 * report the agent actually reads stayed wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPlanImpactTool, detectWaveOverlaps } from "./plan-impact.js";
import { registerAnalysisTools } from "./mcp-tools.js";
import { parsePlanFiles } from "./plan-files.js";
import type { SidecarClient } from "../sidecar/client.js";
import { makeTmpDir, type ToolHandler } from "../test-helpers.js";

// --- Fixture helpers ---

function capture(
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
  // M9a: plan_impact registers via `registerTool` (full strict schema).
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

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function handler(client: SidecarClient | null = null): ToolHandler {
  return capture((s) => registerPlanImpactTool(s, null, client)).get(
    "plan_impact",
  )!;
}

/** A SidecarClient stub exposing only what the tool is allowed to call. */
function fakeClient(spec: { title: string; planFile: string } | null) {
  return { getCurrentSpec: async () => spec } as unknown as SidecarClient;
}

async function run(
  args: Record<string, unknown>,
  client: SidecarClient | null = null,
): Promise<string> {
  return (await handler(client)(args)).content[0].text as string;
}

/**
 * The slice of the report under one `### ` heading.
 *
 * ⛔ D4's negative assertions have to be section-scoped or they are wrong for
 * the wrong reason: a path absent from the overlap findings is legitimately
 * present in the reach half's unscored list, so asserting on the whole report
 * would pin the two halves together — the exact conflation this tool exists to
 * avoid.
 */
function section(text: string, heading: string): string {
  const start = text.indexOf(`### ${heading}`);
  if (start === -1) return "";
  const next = text.indexOf("\n### ", start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/**
 * Two tasks, same wave, same file — the violation `spec-plan.md:220` forbids
 * and nothing currently enforces.
 */
const OVERLAPPING_PLAN = `# Overlap fixture

### Task 1: First

**Wave:** 2

**Files:**
- Modify: \`src/shared.ts\`
- Modify: \`src/only-one.ts\`

### Task 2: Second

**Wave:** 2

**Files:**
- Modify: \`src/shared.ts\`

### Task 3: Third

**Wave:** 3

**Files:**
- Modify: \`src/shared.ts\`
`;

const DISJOINT_PLAN = `# Disjoint fixture

### Task 1: First

**Wave:** 1

**Files:**
- Modify: \`src/a.ts\`

### Task 2: Second

**Wave:** 2

**Files:**
- Modify: \`src/a.ts\`
`;

// --- Registration ---

describe("plan_impact registration", () => {
  it("should register plan_impact on the server it is given", () => {
    expect(
      capture((s) => registerPlanImpactTool(s, null)).has("plan_impact"),
    ).toBe(true);
  });

  it("should be registered by the production entry point", () => {
    const tools = capture((s) =>
      registerAnalysisTools(s, { client: null, store: null }),
    );
    expect(
      tools.has("plan_impact"),
      "registered in its own module but never wired into registerAnalysisTools — invisible to every client",
    ).toBe(true);
  });
});

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  description?: string;
}

describe("plan_impact advertised inputSchema", () => {
  async function advertised(): Promise<JsonSchemaNode> {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerPlanImpactTool(server, null);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "plan_impact");
      expect(tool, "plan_impact is not listed by the server").toBeDefined();
      return tool!.inputSchema as unknown as JsonSchemaNode;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("exposes project (required), plan_path and reach (optional)", async () => {
    const schema = await advertised();
    const props = Object.keys(schema.properties ?? {}).sort();

    expect(props).toEqual(["plan_path", "project", "reach"]);
    expect(schema.required ?? []).toEqual(["project"]);
  });

  it("states in prose that overlap detection needs no injected source", async () => {
    // ⛔ D4 reaches the agent only through `.describe()`. Without it an agent
    // with no code-graph server assumes the tool is not worth calling, and the
    // highest-value half — the only enforcement `spec-plan.md:220` has — is
    // never invoked.
    const schema = await advertised();
    const reach = schema.properties?.reach?.description ?? "";

    expect(reach.toLowerCase()).toContain("optional");
    expect(
      reach,
      "the reach param does not say overlap detection works without it",
    ).toContain("overlap");
  });
});

// --- Overlap detection: deterministic, zero sources ---

describe("plan_impact wave-overlap detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("plan-impact-overlap");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("detects a same-wave overlap with ZERO injected sources", async () => {
    write(tmpDir, "docs/plans/p.md", OVERLAPPING_PLAN);
    const overlap = section(
      await run({ project: tmpDir, plan_path: "docs/plans/p.md" }),
      "Wave Overlap",
    );

    expect(overlap).toContain("`src/shared.ts`");
    expect(overlap).toContain("Wave 2");
    expect(overlap).toContain("Task 1");
    expect(overlap).toContain("Task 2");
    // Task 3 shares the path but sits in a different wave — sequential
    // execution is exactly what the rule permits.
    expect(overlap).not.toContain("Wave 3");
    expect(overlap).not.toContain("`src/only-one.ts`");
  });

  it("reports no overlap when the same file is claimed in different waves", async () => {
    write(tmpDir, "docs/plans/p.md", DISJOINT_PLAN);
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("No same-wave overlaps");
  });

  it("includes the OpenCode shared-working-directory framing", async () => {
    write(tmpDir, "docs/plans/p.md", OVERLAPPING_PLAN);
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("OpenCode");
    expect(text.toLowerCase()).toContain("working directory");
  });

  it("says wave-less tasks CANNOT be assessed rather than assuming wave 1", async () => {
    // The shipped template ships a literal `[1 | 2 | ...]` placeholder, so an
    // unfilled wave is common. Defaulting it to 1 would manufacture overlaps
    // between tasks whose ordering the plan simply never stated.
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Files:**\n- Modify: `src/x.ts`\n\n### Task 2: B\n\n**Files:**\n- Modify: `src/x.ts`\n",
    );
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("No same-wave overlaps");
    expect(text).toContain("cannot be assessed");
    expect(text).toContain("not assumed");
  });

  it("groups three tasks claiming one path into a single finding", () => {
    const tasks = parsePlanFiles(
      (() => {
        write(
          tmpDir,
          "docs/plans/t.md",
          "# t\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Modify: `src/z.ts`\n\n### Task 2: B\n\n**Wave:** 1\n\n**Files:**\n- Modify: `src/z.ts`\n\n### Task 3: C\n\n**Wave:** 1\n\n**Files:**\n- Modify: `src/z.ts`\n",
        );
        return join(tmpDir, "docs/plans/t.md");
      })(),
      tmpDir,
    );
    const overlaps = detectWaveOverlaps(tasks);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].wave).toBe(1);
    expect(overlaps[0].path).toBe("src/z.ts");
    expect(overlaps[0].tasks.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("does not flag a path a single task claims twice under two verbs", () => {
    write(
      tmpDir,
      "docs/plans/t.md",
      "# t\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Create: `src/z.ts`\n- Modify: `src/z.ts`\n",
    );
    const overlaps = detectWaveOverlaps(
      parsePlanFiles(join(tmpDir, "docs/plans/t.md"), tmpDir),
    );

    expect(overlaps).toEqual([]);
  });
});

// --- Epistemic separation (D4) ---

describe("plan_impact output separates the two halves' confidence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("plan-impact-d4");
    write(tmpDir, "docs/plans/p.md", OVERLAPPING_PLAN);
    write(tmpDir, "src/shared.ts", "export const s = 1;\n");
    write(tmpDir, "src/only-one.ts", "export const o = 1;\n");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("labels overlap deterministic and reach advisory", async () => {
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text.toLowerCase()).toContain("deterministic");
    expect(text.toLowerCase()).toContain("advisory");
  });

  it("names the prediction assumption INLINE in the output", async () => {
    // ⛔ Naming it only in the docs leaves the agent reading the report with a
    // number and no idea what bounds it.
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text.toLowerCase()).toContain("prediction");
  });

  it("states that the reach half does not replace verification", async () => {
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("impact_analysis");
    expect(text.toLowerCase()).toContain("does not replace");
  });
});

// --- exists, not verb ---

describe("plan_impact unscored targets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("plan-impact-exists");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reports files that are not on disk separately and explicitly unscored", async () => {
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Create: `src/new.ts`\n- Modify: `src/here.ts`\n",
    );
    write(tmpDir, "src/here.ts", "export const h = 1;\n");
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("`src/new.ts`");
    expect(text.toLowerCase()).toContain("unscored");
    expect(text).toContain("not exist");
  });

  it("keys unscored on `exists`, NOT on the verb", async () => {
    // ⛔ Wave 2's finding: every bugfix plan uses the inline
    // `**Files:** \`a.ts\`, \`b.ts\`` form, which carries NO verb and defaults
    // to `modify`. Keying on the verb would score a file that does not exist
    // — and `countTransitiveImporters` has no node for it, so it would score 0
    // and drag a whole plan of new files to LOW.
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:** `src/ghost.ts`, `src/real.ts`\n",
    );
    write(tmpDir, "src/real.ts", "export const r = 1;\n");
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    const files = parsePlanFiles(join(tmpDir, "docs/plans/p.md"), tmpDir)[0]
      .files;
    expect(
      files.every((f) => f.verb === "modify"),
      "fixture no longer exercises the verb-less inline form",
    ).toBe(true);
    expect(text).toContain("`src/ghost.ts`");
    expect(text).toContain("1 of 2");
  });

  it("accounts for every claimed file — the buckets sum to the total", async () => {
    // Without the not-code bucket the report said "Scored: 15 of 33" and
    // "Unscored: 5 of 33" for this repo's own plan, silently losing 13 files.
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Modify: `src/real.ts`\n- Modify: `README.md`\n- Create: `src/ghost.ts`\n",
    );
    write(tmpDir, "src/real.ts", "export const r = 1;\n");
    write(tmpDir, "README.md", "# r\n");
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("3 distinct files claimed");
    expect(text).toContain("Scored: 1 of 3 claimed files exists on disk");
    expect(text).toContain("1 exists but is not");
    expect(text).toContain("1 does not exist on disk");
  });

  it("flags scored files that lie outside the scanned import tree", async () => {
    // `buildImportGraph` scans `src/` when it exists, so a real `.ts` file
    // under `targets/` counts 0 importers for a reason that has nothing to do
    // with how coupled it is. Reporting that 0 unqualified would be a lie.
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Modify: `targets/opencode/plugins/sentinal.ts`\n",
    );
    write(tmpDir, "src/anchor.ts", "export const a = 1;\n");
    write(
      tmpDir,
      "targets/opencode/plugins/sentinal.ts",
      "export const p = 1;\n",
    );
    const text = await run({ project: tmpDir, plan_path: "docs/plans/p.md" });

    expect(text).toContain("outside the scanned import tree");
    expect(text).toContain("absence of evidence");
  });
});

// --- Reach: injected vs built-in ---

describe("plan_impact prospective reach", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("plan-impact-reach");
    write(
      tmpDir,
      "docs/plans/p.md",
      "# p\n\n### Task 1: A\n\n**Wave:** 1\n\n**Files:**\n- Modify: `src/target.ts`\n",
    );
    write(tmpDir, "src/target.ts", "export const t = 1;\n");
    write(
      tmpDir,
      "src/leaf.ts",
      'import { t } from "./target.js";\nexport const l = t;\n',
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("produces a different, attributed verdict with an injected source", async () => {
    const builtIn = await run({
      project: tmpDir,
      plan_path: "docs/plans/p.md",
    });
    const injected = await run({
      project: tmpDir,
      plan_path: "docs/plans/p.md",
      reach: {
        source: "example-graph tool",
        moduleCount: 334,
        files: { "src/target.ts": 200 },
      },
    });

    expect(builtIn).toContain("**LOW**");
    expect(injected).toContain("**HIGH**");
    expect(
      injected,
      "a verdict computed from someone else's graph must say whose",
    ).toContain("example-graph tool");
    expect(builtIn).not.toContain("example-graph tool");
  });

  it("renders non-primary sources explicitly as unscored", async () => {
    const text = await run({
      project: tmpDir,
      plan_path: "docs/plans/p.md",
      reach: {
        sources: [
          {
            source: "module-level",
            primary: true,
            moduleCount: 334,
            files: { "src/target.ts": 200 },
          },
          {
            source: "symbol-level",
            moduleCount: 8440,
            files: { "src/target.ts": 200 },
          },
        ],
      },
    });

    expect(text).toContain("**HIGH**");
    expect(text).toContain("symbol-level");
    expect(text).toContain("unscored");
  });

  it("still reports overlaps when the injected reach is rejected", async () => {
    // ⛔ D4 in the failure path: overlap detection needs no source, so a bad
    // map must not be able to suppress the half that never depended on it.
    write(tmpDir, "docs/plans/o.md", OVERLAPPING_PLAN);
    write(tmpDir, "src/shared.ts", "export const s = 1;\n");
    write(tmpDir, "src/only-one.ts", "export const o = 1;\n");
    const text = await run({
      project: tmpDir,
      plan_path: "docs/plans/o.md",
      reach: { source: "broken", moduleCount: 10, files: {} },
    });

    expect(text).toContain("Wave 2");
    expect(text).toContain("`src/shared.ts`");
    expect(text.toLowerCase()).toContain("rejected");
  });
});

// --- plan_path resolution ---

describe("plan_impact plan resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("plan-impact-resolve");
    write(tmpDir, "docs/plans/p.md", OVERLAPPING_PLAN);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("defaults plan_path to the active spec resolved through the client", async () => {
    const text = await run(
      { project: tmpDir },
      fakeClient({
        title: "Active spec",
        planFile: join(tmpDir, "docs/plans/p.md"),
      }),
    );

    expect(text).toContain("Active spec");
    expect(text).toContain("Wave 2");
  });

  it("explains itself when there is no plan_path and no active spec", async () => {
    const text = await run({ project: tmpDir }, fakeClient(null));

    expect(text).toContain("plan_path");
    expect(text.toLowerCase()).toContain("no active spec");
  });

  it("reports a missing plan file rather than throwing", async () => {
    const text = await run({
      project: tmpDir,
      plan_path: "docs/plans/nope.md",
    });

    expect(text.toLowerCase()).toContain("no tasks");
  });
});

// --- Pre-Mortem 2: validate against the VERIFIED corpus ---

describe("plan_impact against this repo's VERIFIED plans", () => {
  const repoRoot = process.cwd();
  const plansDir = join(repoRoot, "docs", "plans");

  function verifiedPlans(): string[] {
    return readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(plansDir, f))
      .filter((p) => /^Status:\s*VERIFIED\s*$/m.test(readFileSync(p, "utf-8")));
  }

  it("flags overlaps in at most a small minority of VERIFIED plans", () => {
    // ⛔ Pre-Mortem 2's trigger is "any false positive", and it FIRED: 3 of 89
    // VERIFIED plans carry a genuine same-wave overlap. All three are true
    // against `spec-plan.md:220` as written — none is a parser artifact — but
    // all three shipped. One (`2026-04-02-opencode-v1.3-parity.md`) resolved
    // the conflict in wave PROSE ("Tasks 1+2 both modify sentinal.ts so they
    // must be sequential"), which the per-task `**Wave:**` field cannot
    // express, so it is a false positive in effect. The wording was
    // downgraded accordingly: the output claims a plan-text fact, never harm.
    //
    // This asserts a BOUND, not the exact figure — an exact count would fail
    // on the next plan added for a reason unrelated to this tool.
    const plans = verifiedPlans();
    const flagged = plans.filter(
      (p) => detectWaveOverlaps(parsePlanFiles(p, repoRoot)).length > 0,
    );

    expect(plans.length).toBeGreaterThan(50);
    expect(
      flagged.length / plans.length,
      `overlap flagged in ${flagged.length}/${plans.length} VERIFIED plans: ${flagged.map((p) => p.split("/").pop()).join(", ")}`,
    ).toBeLessThan(0.1);
  });

  it("never claims harm — only that the plan text states a conflict", async () => {
    const tmp = makeTmpDir("plan-impact-wording");
    try {
      write(tmp, "docs/plans/p.md", OVERLAPPING_PLAN);
      const text = await run({ project: tmp, plan_path: "docs/plans/p.md" });

      expect(text.toLowerCase()).toContain("advisory");
      expect(text).not.toContain("blocked");
      // The escape hatch the corpus proved real: a wave declared sequential in
      // prose satisfies the rule in a way the `**Wave:**` field cannot show.
      expect(text.toLowerCase()).toContain("sequential");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses every VERIFIED plan without throwing", () => {
    for (const p of verifiedPlans()) {
      expect(() =>
        detectWaveOverlaps(parsePlanFiles(p, repoRoot)),
      ).not.toThrow();
    }
  });
});

// --- Pre-Mortem 3: performance ---

describe("plan_impact performance", () => {
  it("completes in under 2s on this plan file (11 tasks)", async () => {
    const repoRoot = process.cwd();
    const plan = join(
      repoRoot,
      "docs/plans/2026-08-24-code-graph-impact-planning.md",
    );
    const started = Date.now();
    const text = await run({ project: repoRoot, plan_path: plan });
    const elapsed = Date.now() - started;

    expect(text).toContain("11 task");
    expect(elapsed, `plan_impact took ${elapsed}ms`).toBeLessThan(2000);
  }, 20_000);

  it("reports no same-wave overlap for this plan", () => {
    // Truth 9's second half: this plan's own waves are disjoint by
    // construction (Wave 3 splits `plan-impact.ts` / `sync.md` / `impact.ts`).
    const repoRoot = process.cwd();
    const tasks = parsePlanFiles(
      join(repoRoot, "docs/plans/2026-08-24-code-graph-impact-planning.md"),
      repoRoot,
    );

    expect(detectWaveOverlaps(tasks)).toEqual([]);
  });
});

// --- M9a: strict top-level schema ---

/**
 * Same defect and same fix as `impact.test.ts`'s M9a block: the SDK wraps raw
 * shapes non-strict, so a mis-nested top-level `moduleCount` (no `reach:`
 * wrapper) was silently stripped and the plan scored with the built-in graph.
 * Driven through a real `Client` because strictness lives in transport-side
 * validation, which the capture-based tests above bypass.
 */
describe("plan_impact strict input schema (M9a)", () => {
  async function connected() {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerPlanImpactTool(server, null);
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
        name: "plan_impact",
        arguments: {
          project: "/tmp/nonexistent-project",
          plan_path: "docs/plans/nope.md",
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
      const tool = tools.find((t) => t.name === "plan_impact");
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as unknown as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
    } finally {
      await close();
    }
  });
});
